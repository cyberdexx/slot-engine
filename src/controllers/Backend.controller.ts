// Client for the Playson game backend: XML commands over HTTP POST.
//
// A dependency-free port of what unicore's Connection (transport) and
// gamecore's ServerData / SlotServerData (session + slot round state) do, built
// on fetch, DOMParser and XMLSerializer instead of jQuery.
//
//   connect → reconnect | start   session, game config, unfinished round
//   bet | next                    one round; `next` while the server says so
//   sync                          keep-alive, every `syncTime` ms of silence
//   logout                        on close()

/** Response statuses ServerData treats as errors. */
const ERROR_STATUSES = [
  "error",
  "exit",
  "fail",
  "sessionlost",
  "excess",
  "wrongbet",
];
/** Commands that go to the gift-spins server when they carry a <gift-spins> node. */
const GIFT_COMMANDS = ["bet", "next", "bonus", "game", "freespin"];
/** Commands whose response status does not become the round status. */
const PASSIVE_COMMANDS = ["sync", "pool", "shifter"];

export enum WinLevel {
  Normal = 0,
  Big = 1,
  Super = 2,
  Mega = 3,
}

export interface BackendOptions {
  /** Game id on the backend (`gid`, `gameid`). */
  game: string;
  /** Backend base URL; the command is inserted into it (see commandURL). */
  serverURL: string;
  /** Gift-spins backend, for commands that carry a <gift-spins> node. */
  giftServerURL?: string;
  serverID?: string;
  /** Session to resume instead of starting with connect. */
  session?: string;
  wlCode?: string;
  projectId?: string | number;
  showRtp?: boolean;
  columns: number;
  rows: number;
  lines: number;
  player?: {
    /** `playerguid` on connect. */
    key?: string;
    platform?: "desk" | "mob";
    environment?: string;
  };
  build?: {
    version?: string;
    date?: number;
    certVersion?: string;
    showCertVersion?: boolean;
  };
  engineVersion?: string;
  /** Per-attempt request timeout, ms. */
  timeout?: number;
  /** Attempts per request before it fails. */
  timeoutAttempts?: number;
  /**
   * On a failed request keep it queued and pause until retry() (or the next
   * send) instead of rejecting it and dropping the queue.
   */
  performRetry?: boolean;
  /** Silence after the last response before a sync, ms. */
  syncTime?: number;
  /**
   * Answers requests instead of the server, e.g. for offline work or forced
   * results. Receives the serialized <client> message.
   */
  mock?: (request: string, command: string) => string | Promise<string>;
  /** Request / response / error log; console.debug when not set. */
  log?: (type: "request" | "response" | "error", message: string) => void;
}

export interface Win {
  /** Payline id; absent for wins without a line (newwin). */
  number?: number;
  /** Row (1-based) of the winning symbol on each reel. */
  layout: number[];
  /** Payout, in cents. */
  paid: number;
  comb: number | string;
  symbols?: number[];
}

export interface Payline {
  id: number;
  path: number[];
}

export interface CurrencyFormat {
  denominator?: string;
  groupingDelimiter: string;
  fractionalDelimiter: string;
  fract?: string;
}

export interface Response {
  command: string;
  status: string;
  /** The <server> node; parse anything game-specific from it. */
  xml: Element;
  /** Raw response text. */
  text: string;
  /** `x-platform-trace-id`. */
  requestId: string | null;
  /** `x-response-time`. */
  responseTime: string | null;
}

export interface BackendEvents {
  request: { command: string; message: string };
  retry: { command: string; attempt: number };
  response: Response;
  /** A request failed for good (code ACCESS_DENIED for 307/403), or a fire-and-forget command errored. */
  error: { command: string; code?: string; error: unknown };
  /** Round state changed: after a parsed response, or freespins start/stop. */
  update: { response?: Response };
}

type Parser = (response: Response) => void;

interface QueueEntry {
  message: Element;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}

export class BackendError extends Error {
  constructor(
    readonly command: string,
    readonly status: string,
    readonly code?: string,
    readonly details?: unknown,
    readonly response?: Response,
  ) {
    super(`${command}: ${status}${code ? ` ${code}` : ""}`);
  }
}

class RequestError extends Error {
  constructor(
    readonly code?: string,
    readonly statusCode?: number | string,
  ) {
    super(`request failed${statusCode ? ` (${statusCode})` : ""}`);
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const numbers = (value: string | null | undefined, separator = ",") =>
  value ? value.split(separator).map(Number) : [];

export class BackendController extends EventTarget {
  // ─── Transport (unicore Connection) ───────────────────────────────────────
  session: string | null;
  wlCode?: string;
  syncTime: number;

  private queue: QueueEntry[] = [];
  private current: QueueEntry | null = null;
  private abort: AbortController | null = null;
  private syncTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private lastRnd = 0;
  private pendingRnd = 0;
  private previous: Record<string, { rnd: string; requestId: string | null }> =
    {};
  private parsers: {
    command: string | RegExp;
    parser: Parser;
    error: boolean;
  }[] = [];

  // ─── Session and round state (gamecore ServerData / SlotServerData) ───────
  /** What connect asked for: "start" | "reconnect" | "leave". */
  mode?: "start" | "reconnect" | "leave";
  /** Status of the last round-affecting response, e.g. "ok" or "next". */
  status = "bet";
  errorCode: string | null = null;
  errorMessage: unknown = null;
  /** Balance, in cents. */
  balance = 0;
  /** Line bet of the last round, in cents. */
  bet = 1;
  totalBetMultiplier = 1;
  /** Line bets (cents) on offer and the index of the default one, from the start/reconnect config. */
  stakes: number[] = [];
  defaultStake?: number;
  /** Attributes of every <combination> / <scatter> in the paytable. */
  payouts: Record<string, string>[] = [];
  paylines: Payline[] = [];
  symbols: Record<number, string> = {};
  reelSet = 1;
  /** Reel strips: reelSets[set][reel] = symbol ids. */
  reelSets: Record<number, Record<string, number[]>> = {};
  /** Symbol ids per reel, top to bottom. */
  matrix: number[][];
  defaultMatrix: number[][];
  wins: Win[] = [];
  roundWin = false;
  /** Win of the last round, in cents. */
  roundPaid = 0;
  freespinsActive = false;
  freespinsNumber = 0;
  freespinsTotalNumber = 0;
  freespinsAwarded = 0;
  freespinsLimit = Number.POSITIVE_INFINITY;
  freespinsPaid = 0;
  freespinsTriggerPaid = 0;
  currencyFormat: CurrencyFormat | null = null;
  /** Last command and <game_version>, for the math tools. */
  mathToolPayload?: { lastCommand: string; debug: string };

  constructor(private options: BackendOptions) {
    super();
    this.session = options.session ?? null;
    this.wlCode = options.wlCode;
    this.syncTime = options.syncTime ?? 15000;
    this.pendingRnd = this.newRnd();
    this.matrix = this.emptyMatrix();
    this.defaultMatrix = this.emptyMatrix();

    this.addParser("connect", ({ xml }) => {
      const game = xml.querySelector("game");
      this.mode = !game
        ? "start"
        : game.getAttribute("name") === options.game
          ? "reconnect"
          : "leave";
    });
    this.addParser("start", (response) => this.parseStart(response.xml));
    this.addParser("reconnect", (response) =>
      this.parseReconnect(response.xml),
    );
    this.addParser(/^(bet|next)$/, (response) => this.parseBet(response.xml));
    this.addErrorParser(/.+/, (response) => this.parseError(response));
    this.addErrorParser(/^(bet|next)$/, () => {
      this.roundPaid = 0;
      this.wins = [];
      this.matrix = this.defaultMatrix.map((reel) => [...reel]);
    });
    this.addErrorParser("sync", ({ status }) => (this.status = status));
  }

  /** Listens to a backend event; returns the unsubscribe function. */
  on<K extends keyof BackendEvents>(
    type: K,
    listener: (detail: BackendEvents[K]) => void,
  ) {
    const handler = (event: Event) =>
      listener((event as CustomEvent<BackendEvents[K]>).detail);
    this.addEventListener(type, handler);
    return () => this.removeEventListener(type, handler);
  }

  // ─── Session ──────────────────────────────────────────────────────────────

  /**
   * connect, then reconnect / start (leaving another game's unfinished round
   * first). Can be called while assets are still loading.
   */
  async connect(giftSpinId?: string) {
    await this.send(this.createConnectMessage());
    if (this.mode === "leave") await this.leave();
    return this.mode === "reconnect"
      ? this.reconnect(giftSpinId)
      : this.start();
  }

  /** Game config and the unfinished round, if any. */
  reconnect(giftSpinId?: string) {
    const message = this.createMessage("reconnect");
    if (giftSpinId) this.append(message, "gift-spins", { id: giftSpinId });
    return this.send(message);
  }

  start() {
    const message = this.createMessage("start");
    this.append(message, "game", { id: this.options.game });
    return this.send(message);
  }

  leave() {
    return this.send(this.createMessage("leave"));
  }

  /** Sends logout and stops all traffic. */
  close() {
    if (this.closed) return;
    this.reset();
    void this.send(this.createMessage("logout")).catch(() => {});
    this.closed = true;
  }

  // ─── Rounds ───────────────────────────────────────────────────────────────

  /** One round at `lineBet` cents per line (total = lineBet × totalBetMultiplier). */
  async spin(lineBet = this.bet) {
    const message = this.createMessage(this.status === "next" ? "next" : "bet");
    this.append(message, "bet", { cash: lineBet });
    await this.send(message);
    return {
      matrix: this.matrix.map((reel) => [...reel]),
      wins: this.wins,
      win: this.roundPaid,
      balance: this.balance,
    };
  }

  /** Replace for game-specific big-win thresholds (paid and bet in cents). */
  getWinLevel: (paid: number, bet: number) => WinLevel = () => WinLevel.Normal;

  hasBonusWins() {
    return this.freespinsAwarded > 0;
  }

  /** The line bet to start with, in cents: the default stake, or the last one on offer (as unicore). */
  get defaultLineBet() {
    return (
      this.stakes[this.defaultStake ?? -1] ??
      this.stakes[this.stakes.length - 1] ??
      this.bet
    );
  }

  /** Total bet for a line bet, in cents. */
  totalBet(lineBet = this.bet) {
    return lineBet * this.totalBetMultiplier;
  }

  startFreespins(notify = true) {
    this.wins = [];
    this.matrix = this.defaultMatrix.map((reel) => [...reel]);
    if (notify) this.emit("update", {});
  }

  stopFreespins(notify = true) {
    this.wins = [];
    this.matrix = this.defaultMatrix.map((reel) => [...reel]);
    this.freespinsTotalNumber = 0;
    if (notify) this.emit("update", {});
  }

  /**
   * Queues forced results on dev servers: each combination is a list of reel
   * stops, sent as <shift value="…"/>. Bonus (`b:`) and special (`s:`)
   * combinations are game-specific, as in gamecore.
   */
  sendShiftCombinations(combinations: (string | number)[][]) {
    if (combinations.some(([first]) => /^[bs]:/.test(String(first)))) {
      throw new Error("Bonus and special shift combinations are game-specific");
    }
    const message = this.createMessage("pool");
    const game = this.append(message, "game", { id: this.options.game });
    combinations.forEach((combination) =>
      this.append(game, "shift", {
        value: combination.join(", "),
        clear: "true",
      }),
    );
    return this.send(message);
  }

  // ─── Parsers ──────────────────────────────────────────────────────────────

  /** Runs `parser` on successful responses to `command`, in registration order. */
  addParser(command: string | RegExp, parser: Parser) {
    this.parsers.push({ command, parser, error: false });
  }

  /** Runs `parser` on error responses to `command`. */
  addErrorParser(command: string | RegExp, parser: Parser) {
    this.parsers.push({ command, parser, error: true });
  }

  protected parseStart(xml: Element) {
    this.bet = 0;
    this.totalBetMultiplier = Number(
      xml.querySelector("game_type")?.getAttribute("total_bet_mult") ??
        xml.querySelector(":scope > game")?.getAttribute("total_bet_mult") ??
        1,
    );

    this.payouts = [
      ...xml.querySelectorAll("combinations combination, scatter"),
    ].map((node) =>
      Object.fromEntries(
        [...node.attributes].map(({ name, value }) => [name, value]),
      ),
    );
    this.paylines = [...xml.querySelectorAll("paylines payline[id]")].map(
      (node) => ({
        id: Number(node.getAttribute("id")),
        path: numbers(node.getAttribute("path")),
      }),
    );
    xml.querySelectorAll("symbols symbol").forEach((node) => {
      this.symbols[Number(node.getAttribute("id"))] =
        node.getAttribute("title") ?? "";
    });
    this.stakes = numbers(
      xml.querySelector("extra stakeIncrement")?.textContent,
    );
    const defaultStake = xml.querySelector("extra defaultBet")?.textContent;
    this.defaultStake = defaultStake ? Number(defaultStake) : undefined;

    this.reelSet =
      Number(xml.querySelector("shift")?.getAttribute("reel_set")) || 1;
    this.reelSets = {};
    xml
      .querySelectorAll(
        "reels, reels2, reels3, reels4, reels5, reels6, reels7, reels8, reels_b",
      )
      .forEach((set) => {
        const reels: Record<string, number[]> = {};
        set.querySelectorAll("reel").forEach((reel) => {
          const strip =
            reel.getAttribute("layout") ?? reel.getAttribute("symbols");
          if (strip) reels[reel.getAttribute("id") ?? ""] = numbers(strip);
        });
        this.reelSets[Number(set.getAttribute("id"))] = reels;
      });

    const limit = xml
      .querySelector('limit[id="freespins_seq"]')
      ?.getAttribute("max");
    this.freespinsLimit = Number(limit || Number.POSITIVE_INFINITY);

    this.parseMatrix(xml);
    this.defaultMatrix = this.matrix.map((reel) => [...reel]);
    this.parseFormatter(xml);
    this.mathToolPayload = this.parseMathToolPayload(xml);
  }

  protected parseReconnect(xml: Element) {
    this.parseStart(xml);
    this.freespinsTriggerPaid = Number(
      xml.querySelector(":scope > game")?.getAttribute("last_nfs_win") ?? 0,
    );

    const spinCmd = xml.querySelector("spin_cmd");
    if (spinCmd) {
      this.status = spinCmd.getAttribute("status") ?? this.status;
      this.parseBet(spinCmd);
    }
    // That was the last round of freespins.
    if (this.freespinsActive && this.freespinsNumber === 0) {
      this.stopFreespins(false);
    }
    this.parseFormatter(xml);
  }

  protected parseBet(xml: Element) {
    const game = xml.querySelector("game");
    const attr = (name: string) => Number(game?.getAttribute(name) ?? 0);

    this.bet = attr("line-bet");
    this.reelSet =
      Number(xml.querySelector("shift")?.getAttribute("reel_set")) || 1;
    this.roundWin = !!xml.querySelector(":scope > wins");
    this.wins = [];
    xml.querySelectorAll(":scope > wins > win").forEach((node) => {
      const number = Number(node.getAttribute("line"));
      // The server reports scatter wins as line 0 or below.
      if (number < 0) return;
      this.wins.push({
        number,
        layout: numbers(node.getAttribute("layout"), ""),
        paid: Number(node.getAttribute("cash")),
        comb: Number(node.getAttribute("comb")) || 0,
        symbols: numbers(node.getAttribute("comb_symbols")),
      });
    });
    xml.querySelectorAll(":scope > wins > newwin[layout]").forEach((node) => {
      this.wins.push({
        layout: numbers(node.getAttribute("layout"), ""),
        paid: Number(node.getAttribute("cash") ?? 0),
        comb: node.getAttribute("comb") ?? "",
      });
    });
    this.wins.sort((a, b) =>
      a.number === undefined
        ? 1
        : b.number === undefined
          ? -1
          : (a.symbols?.length ?? 0) === (b.symbols?.length ?? 0)
            ? a.paid === b.paid
              ? a.number - b.number
              : b.paid - a.paid
            : (b.symbols?.length ?? 0) - (a.symbols?.length ?? 0),
    );

    this.freespinsActive = attr("cash-bet") === 0;
    this.freespinsNumber = attr("bonus_games");
    const total = attr("original_bonus_games");
    this.freespinsAwarded =
      this.freespinsNumber > 0 ? total - this.freespinsTotalNumber : 0;
    this.freespinsTotalNumber = total;
    this.roundPaid = attr("cash-win");
    if (!this.freespinsActive) {
      this.freespinsTriggerPaid =
        this.freespinsAwarded > 0 ? this.roundPaid : 0;
    }
    this.freespinsPaid = attr("free-win") + this.freespinsTriggerPaid;

    this.parseMatrix(xml);
    this.mathToolPayload = this.parseMathToolPayload(xml);
  }

  protected parseMatrix(xml: Element) {
    const shift = xml.querySelector("shift");
    if (!shift) return;
    for (let column = 0; column < this.options.columns; column++) {
      const reel = numbers(shift.getAttribute(`reel${column + 1}`));
      if (reel.slice(0, this.options.rows).some(Number.isNaN)) {
        throw new Error("Incorrect matrix received from server.");
      }
      this.matrix[column] = reel;
    }
  }

  protected parseFormatter(xml: Element) {
    const money = xml.querySelector("format money");
    this.currencyFormat = money && {
      denominator: money.getAttribute("denominator") ?? undefined,
      groupingDelimiter: money.getAttribute("grouping_delimiter") || " ",
      fractionalDelimiter: money.getAttribute("fractional_delimiter") || ".",
      fract: money.getAttribute("fract") ?? undefined,
    };
  }

  protected parseMathToolPayload(xml: Element) {
    return {
      lastCommand: xml.getAttribute("command") ?? "",
      debug: xml.querySelector("game_version")?.innerHTML ?? "",
    };
  }

  /** extra>error code and message; the message may carry JSON. */
  protected parseError({ xml }: Response) {
    const error = xml.querySelector("extra > error");
    this.errorCode = error?.getAttribute("code") ?? null;
    const text = error?.querySelector("msg")?.textContent;
    if (text === undefined || text === null) return;
    try {
      this.errorMessage = JSON.parse(text);
    } catch {
      this.errorMessage = text;
    }
  }

  // ─── Messages ─────────────────────────────────────────────────────────────

  /** A <client> message with session, rnd and the previous rnd/request id of this command. */
  createMessage(command: string) {
    const message = document.implementation.createDocument(
      null,
      "client",
    ).documentElement!;
    if (this.session) message.setAttribute("session", this.session);
    const previous = this.previous[command];
    if (previous?.rnd) message.setAttribute("prnd", previous.rnd);
    if (previous?.requestId) message.setAttribute("prid", previous.requestId);
    if (this.options.showRtp) message.setAttribute("show_rtp", "true");
    message.setAttribute("rnd", String(this.nextRnd()));
    message.setAttribute("command", command);
    return message;
  }

  createConnectMessage() {
    const { player = {}, build = {}, game } = this.options;
    const message = this.createMessage("connect");
    const attrs: Record<string, string | undefined> = {
      playerguid: player.key ?? "TEST1000",
      gameid: game,
      platform: player.platform ?? "desk",
      engine_type: "unicore",
      engine_version: this.options.engineVersion ?? "0.0",
      wl: this.wlCode,
      environment: player.environment,
    };
    Object.entries(attrs).forEach(
      ([name, value]) => value && message.setAttribute(name, value),
    );
    const certVersion = build.showCertVersion && build.certVersion;
    this.append(message, "debug", {
      build_date: build.date ?? Date.now(),
      build_version: certVersion || build.version || "0.0.0",
    });
    return message;
  }

  /** Appends <name …attrs/> to `parent` and returns it. */
  append(
    parent: Element,
    name: string,
    attrs: Record<string, string | number> = {},
  ) {
    const child = parent.ownerDocument.createElement(name);
    Object.entries(attrs).forEach(([key, value]) =>
      child.setAttribute(key, String(value)),
    );
    parent.appendChild(child);
    return child;
  }

  // ─── Transport ────────────────────────────────────────────────────────────

  /** Queues a message; resolves with the parsed response, rejects with BackendError on an error status. */
  send(message: Element) {
    return new Promise<Response>((resolve, reject) => {
      this.queue.push({ message, resolve, reject });
      if (!this.current) void this.next();
    });
  }

  /** Resumes the queue after a failed request kept by performRetry. */
  retry() {
    if (!this.current) void this.next();
  }

  sync() {
    return this.send(this.createMessage("sync"));
  }

  private async next() {
    const entry = this.queue.shift();
    if (!entry) return;
    this.current = entry;

    const { message } = entry;
    const command = message.getAttribute("command") ?? "";
    const body = new XMLSerializer().serializeToString(message);
    this.emit("request", { command, message: body });
    this.log("request", body);

    let raw: Awaited<ReturnType<BackendController["post"]>>;
    try {
      raw = this.options.mock
        ? {
            text: await this.options.mock(body, command),
            requestId: null,
            responseTime: null,
          }
        : await this.post(this.requestURL(message, command), body, command);
    } catch (error) {
      if (this.closed || this.current !== entry) return;
      this.current = null;
      const code = error instanceof RequestError ? error.code : undefined;
      this.log("error", `${command}: ${String(error)}`);
      if (this.options.performRetry ?? true) {
        // Kept at the head of the queue until retry() or the next send().
        this.queue.unshift(entry);
      } else {
        entry.reject(error);
        this.reset();
      }
      this.emit("error", { command, code, error });
      return;
    }
    if (this.closed || this.current !== entry) return;

    // The server has processed the request by now, so a response that fails
    // to parse is never re-sent — that could repeat a bet.
    this.current = null;
    try {
      const response = this.handle(message, command, raw);
      if (ERROR_STATUSES.includes(response.status)) {
        entry.reject(
          new BackendError(
            command,
            response.status,
            this.errorCode ?? undefined,
            this.errorMessage,
            response,
          ),
        );
      } else {
        entry.resolve(response);
      }
    } catch (error) {
      this.log("error", `${command}: ${String(error)}`);
      entry.reject(error);
      this.emit("error", { command, error });
    }
    if (this.queue.length) void this.next();
  }

  private async post(url: string, body: string, command: string) {
    const timeout = this.options.timeout ?? 10000;
    const attempts = this.options.timeoutAttempts ?? 5;

    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) this.emit("retry", { command, attempt });
      const started = Date.now();
      const abort = new AbortController();
      this.abort = abort;
      let statusCode: number | string = "error";
      try {
        const timer = setTimeout(() => abort.abort("timeout"), timeout);
        const res = await fetch(url, {
          method: "POST",
          body,
          signal: abort.signal,
        }).finally(() => clearTimeout(timer));
        statusCode = res.status;
        if (res.ok) {
          return {
            text: await res.text(),
            requestId: res.headers.get("x-platform-trace-id"),
            responseTime: res.headers.get("x-response-time"),
          };
        }
      } catch (error) {
        if (abort.signal.reason === "reset") throw error;
        statusCode = abort.signal.reason === "timeout" ? "timeout" : "error";
      }

      this.log(
        "error",
        `Connection error: status=${statusCode} ${url} attempt=${attempt}`,
      );
      if (statusCode === 307 || statusCode === 403) {
        throw new RequestError("ACCESS_DENIED", statusCode);
      }
      if (attempt >= attempts) throw new RequestError(undefined, statusCode);
      // A fast failure waits out the rest of the timeout before retrying.
      const left = timeout - (Date.now() - started);
      if (statusCode !== "timeout" && left > 0) await wait(left);
    }
  }

  private handle(
    message: Element,
    command: string,
    raw: {
      text: string;
      requestId: string | null;
      responseTime: string | null;
    },
  ): Response {
    this.log("response", raw.text);
    const xml = new DOMParser()
      .parseFromString(raw.text, "text/xml")
      .querySelector("server");
    if (!xml) throw new RequestError(undefined, "bad response");

    const status = xml.getAttribute("status") ?? "";
    const response: Response = { command, status, xml, ...raw };

    this.previous[command] = {
      rnd: message.getAttribute("rnd") ?? "",
      requestId: raw.requestId,
    };
    this.scheduleSync();

    if (command === "connect") {
      this.session = xml.getAttribute("session");
      const wlCode = xml.querySelector("user")?.getAttribute("wlcode");
      if (wlCode) this.wlCode = wlCode;
    }
    const cash = xml.querySelector("user_new")?.getAttribute("cash");
    if (cash) this.balance = Number(cash);
    if (!PASSIVE_COMMANDS.includes(command)) this.status = status;

    const isError = ERROR_STATUSES.includes(status);
    try {
      this.parsers
        .filter(
          ({ command: match, error }) =>
            error === isError &&
            (typeof match === "string"
              ? match === command
              : match.test(command)),
        )
        .forEach(({ parser }) => parser.call(this, response));
    } catch (error) {
      throw new Error(`Response parsing failed: ${(error as Error).stack}`);
    }

    this.emit("response", response);
    this.emit("update", { response });
    return response;
  }

  /**
   * As unicore: https://host → https://host/<command>,
   * https://host?query → https://host/<command>?query, otherwise the command
   * goes before the last path segment (https://host/a/b → https://host/a/<command>/b).
   */
  commandURL(url: string, command: string) {
    if (/^https?:\/\/[^/?]+$/.test(url)) return `${url}/${command}`;
    if (/^https?:\/\/[^/]+\?[^/]+$/.test(url))
      return url.replace("?", `/${command}?`);
    return url.replace(/\/([^/]+)(\?.*)?$/, `/${command}/$1$2`);
  }

  private requestURL(message: Element, command: string) {
    const { serverURL, giftServerURL, serverID, projectId, game } =
      this.options;
    const gift =
      !!giftServerURL &&
      GIFT_COMMANDS.includes(command) &&
      !!message.querySelector("gift-spins");
    let url = this.commandURL(gift ? giftServerURL! : serverURL, command);
    url += `${url.includes("?") ? "&" : "?"}r=${this.nextRnd()}`;
    if (!url.includes("gid=")) url += `&gid=${game}`;
    if (serverID) url += `&server_id=${serverID}`;
    if (this.wlCode !== undefined) url += `&wlCode=${this.wlCode}`;
    if (projectId !== undefined && projectId !== null)
      url += `&projectId=${projectId}`;
    return url;
  }

  private scheduleSync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(
      () =>
        void this.sync().catch((error) =>
          this.emit("error", { command: "sync", error }),
        ),
      this.syncTime,
    );
  }

  private reset() {
    const pending = [...(this.current ? [this.current] : []), ...this.queue];
    pending.forEach(({ reject }) => reject(new Error("Backend reset")));
    this.queue = [];
    this.current = null;
    this.abort?.abort("reset");
    clearTimeout(this.syncTimer);
  }

  /** Monotonic, time-based rnd; the previous one is what the server sees as prnd. */
  private nextRnd() {
    const rnd = this.pendingRnd || this.newRnd();
    this.lastRnd = rnd;
    this.pendingRnd = this.newRnd();
    return rnd;
  }

  private newRnd() {
    const now = Date.now();
    return now <= this.lastRnd ? this.lastRnd + 1 : now;
  }

  private emptyMatrix() {
    return Array.from({ length: this.options.columns }, () =>
      new Array<number>(this.options.rows).fill(1),
    );
  }

  private emit<K extends keyof BackendEvents>(
    type: K,
    detail: BackendEvents[K],
  ) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private log(type: "request" | "response" | "error", message: string) {
    if (this.options.log) this.options.log(type, message);
    else console.debug(`[backend] ${type}`, message);
  }
}
