import type { CallToolResult } from "mcp-use";

export interface RestrictedProgramLimits {
  readonly maxProgramBytes: number;
  readonly maxStatements: number;
  readonly maxCalls: number;
  readonly maxMilliseconds: number;
  readonly maxOutputBytes: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
}

export const DEFAULT_RESTRICTED_PROGRAM_LIMITS: RestrictedProgramLimits = {
  maxProgramBytes: 32 * 1024,
  maxStatements: 64,
  maxCalls: 8,
  maxMilliseconds: 5_000,
  maxOutputBytes: 64 * 1024,
  maxNodes: 2_048,
  maxDepth: 32,
};

export interface HostToolCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface RestrictedProgramHost {
  invoke(call: HostToolCall, signal: AbortSignal): Promise<CallToolResult>;
}

export interface RestrictedProgramResult {
  readonly result: unknown;
  readonly calls: number;
  readonly directToolResult?: CallToolResult;
}

/**
 * Run the Gateway's deliberately small JavaScript subset.
 *
 * This is an interpreter, not `eval`, `Function`, or a host JavaScript realm.
 * It parses values and direct `tools.name({...})` calls into an allowlisted
 * syntax tree. Consequently a program has no language path to fetch,
 * filesystem APIs, globals, constructors, imports, or credentials. All
 * effects go through `host.invoke`, where Gateway checks the current grant.
 */
export async function executeRestrictedProgram(
  source: string,
  host: RestrictedProgramHost,
  limits: RestrictedProgramLimits = DEFAULT_RESTRICTED_PROGRAM_LIMITS,
): Promise<RestrictedProgramResult> {
  if (new TextEncoder().encode(source).byteLength > limits.maxProgramBytes) {
    throw new RestrictedProgramError("Program is too large.");
  }

  const program = new Parser(
    source,
    limits.maxStatements,
    limits.maxNodes,
    limits.maxDepth,
  ).parse();
  const boundedHost: RestrictedProgramHost = {
    invoke: (call, signal) =>
      invokeWithDeadline(
        host,
        call,
        signal,
        limits.maxMilliseconds,
        limits.maxOutputBytes,
      ),
  };
  const variables = new Map<string, unknown>();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.maxMilliseconds);
  let calls = 0;
  let finalValue: unknown;
  let directToolResult: CallToolResult | undefined;

  try {
    for (const statement of program) {
      if (statement.kind === "binding") {
        const evaluated = await evaluateExpression(
          statement.expression,
          variables,
          boundedHost,
          controller,
          () => {
            calls += 1;
            if (calls > limits.maxCalls) {
              throw new RestrictedProgramError("Program call limit exceeded.");
            }
            return calls;
          },
        );
        boundedJson(evaluated.value, limits.maxOutputBytes);
        variables.set(statement.name, evaluated.value);
        continue;
      }
      if (statement.kind === "expression") {
        const evaluated = await evaluateExpression(
          statement.expression,
          variables,
          boundedHost,
          controller,
          () => {
            calls += 1;
            if (calls > limits.maxCalls) {
              throw new RestrictedProgramError("Program call limit exceeded.");
            }
            return calls;
          },
        );
        boundedJson(evaluated.value, limits.maxOutputBytes);
        continue;
      }
      const evaluated = await evaluateExpression(
        statement.expression,
        variables,
        boundedHost,
        controller,
        () => {
          calls += 1;
          if (calls > limits.maxCalls) {
            throw new RestrictedProgramError("Program call limit exceeded.");
          }
          return calls;
        },
      );
      finalValue = evaluated.value;
      directToolResult = evaluated.toolResult;
      break;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new RestrictedProgramError("Program execution timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }

  const output = Math.max(
    safeJsonBytes(finalValue, limits.maxOutputBytes),
    directToolResult === undefined
      ? 0
      : safeJsonBytes(directToolResult, limits.maxOutputBytes),
  );
  if (output > limits.maxOutputBytes) {
    throw new RestrictedProgramError("Program output is too large.");
  }
  return { result: finalValue, calls, directToolResult };
}

export class RestrictedProgramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestrictedProgramError";
  }
}

type Program = Statement[];
type Statement =
  | {
      readonly kind: "binding";
      readonly name: string;
      readonly expression: Expression;
    }
  | { readonly kind: "expression"; readonly expression: Expression }
  | { readonly kind: "return"; readonly expression: Expression };
type Expression =
  | { readonly kind: "literal"; readonly value: unknown }
  | {
      readonly kind: "object";
      readonly entries: readonly [string, Expression][];
    }
  | { readonly kind: "array"; readonly items: readonly Expression[] }
  | {
      readonly kind: "variable";
      readonly name: string;
      readonly path: readonly string[];
    }
  | {
      readonly kind: "call";
      readonly name: string;
      readonly arguments: readonly Expression[];
    };

interface Evaluated {
  readonly value: unknown;
  readonly toolResult?: CallToolResult;
}

async function evaluateExpression(
  expression: Expression,
  variables: Map<string, unknown>,
  host: RestrictedProgramHost,
  controller: AbortController,
  nextCall: () => number,
): Promise<Evaluated> {
  if (expression.kind === "literal") return { value: expression.value };
  if (expression.kind === "variable") {
    if (!variables.has(expression.name)) {
      throw new RestrictedProgramError(
        "Program references an unknown variable.",
      );
    }
    let value = variables.get(expression.name);
    for (const property of expression.path) {
      if (
        value === null ||
        typeof value !== "object" ||
        !Object.prototype.hasOwnProperty.call(value, property)
      ) {
        return { value: undefined };
      }
      value = (value as Record<string, unknown>)[property];
    }
    return { value };
  }
  if (expression.kind === "array") {
    const items: unknown[] = [];
    for (const item of expression.items) {
      items.push(
        (await evaluateExpression(item, variables, host, controller, nextCall))
          .value,
      );
    }
    return { value: items };
  }
  if (expression.kind === "object") {
    const value: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const [key, item] of expression.entries) {
      value[key] = (
        await evaluateExpression(item, variables, host, controller, nextCall)
      ).value;
    }
    return { value };
  }

  const input = (
    await Promise.all(
      expression.arguments.map((argument) =>
        evaluateExpression(argument, variables, host, controller, nextCall),
      ),
    )
  ).map(({ value }) => value);
  if (input.length !== 1 || !isRecord(input[0])) {
    throw new RestrictedProgramError(
      "Gateway tools accept exactly one object argument.",
    );
  }
  nextCall();
  const toolResult = await host.invoke(
    { name: expression.name, input: input[0] },
    controller.signal,
  );
  return {
    value: toolValue(toolResult),
    toolResult,
  };
}

async function invokeWithDeadline(
  host: RestrictedProgramHost,
  call: HostToolCall,
  signal: AbortSignal,
  milliseconds: number,
  maxOutputBytes: number,
): Promise<CallToolResult> {
  if (signal.aborted) {
    throw new RestrictedProgramError("Program execution timed out.");
  }
  let timer: number | undefined;
  let removeAbortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RestrictedProgramError("Program execution timed out.")),
      milliseconds,
    );
  });
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () =>
      reject(new RestrictedProgramError("Program execution timed out."));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    const result = await Promise.race([
      host.invoke(call, signal),
      timeout,
      aborted,
    ]);
    if (safeJsonBytes(result, maxOutputBytes) > maxOutputBytes) {
      throw new RestrictedProgramError("Program output is too large.");
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener?.();
  }
}

function toolValue(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text");
  if (text?.type === "text") {
    try {
      return JSON.parse(text.text) as unknown;
    } catch {
      return text.text;
    }
  }
  return result;
}

function safeJsonBytes(value: unknown, maxBytes: number): number {
  return new TextEncoder().encode(boundedJson(value, maxBytes)).byteLength;
}

export function serializeBoundedJson(value: unknown, maxBytes: number): string {
  return boundedJson(value, maxBytes);
}

function boundedJson(value: unknown, maxBytes: number): string {
  const chunks: string[] = [];
  const seen = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  const encoder = new TextEncoder();
  const append = (text: string) => {
    bytes += encoder.encode(text).byteLength;
    if (bytes > maxBytes) {
      throw new RestrictedProgramError("Program output is too large.");
    }
    chunks.push(text);
  };
  const quote = (text: string) => {
    append('"');
    for (const character of text) {
      const code = character.codePointAt(0) ?? 0;
      if (character === '"') append('\\"');
      else if (character === "\\") append("\\\\");
      else if (character === "\n") append("\\n");
      else if (character === "\r") append("\\r");
      else if (character === "\t") append("\\t");
      else if (code < 0x20) append(`\\u${code.toString(16).padStart(4, "0")}`);
      else append(character);
    }
    append('"');
  };
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 4096 || depth > 64) {
      throw new RestrictedProgramError("Program output is too complex.");
    }
    if (current === null) {
      append("null");
      return;
    }
    if (typeof current === "string") {
      quote(current);
      return;
    }
    if (typeof current === "boolean") {
      append(current ? "true" : "false");
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new RestrictedProgramError("Program output is not serializable.");
      }
      append(String(current));
      return;
    }
    if (typeof current !== "object") {
      append("null");
      return;
    }
    if (seen.has(current)) {
      throw new RestrictedProgramError("Program output is not serializable.");
    }
    seen.add(current);
    if (Array.isArray(current)) {
      append("[");
      for (let index = 0; index < current.length; index += 1) {
        if (index > 0) append(",");
        visit(current[index], depth + 1);
      }
      append("]");
    } else {
      append("{");
      const keys = Object.keys(current);
      for (let index = 0; index < keys.length; index += 1) {
        if (index > 0) append(",");
        const key = keys[index];
        quote(key);
        append(":");
        visit((current as Record<string, unknown>)[key], depth + 1);
      }
      append("}");
    }
    seen.delete(current);
  };
  visit(value, 0);
  return chunks.join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const BLOCKED_NAMES = new Set([
  "constructor",
  "Deno",
  "eval",
  "fetch",
  "Function",
  "globalThis",
  "import",
  "process",
  "prototype",
  "require",
  "WebSocket",
  "window",
]);

interface Token {
  readonly kind: "identifier" | "number" | "string" | "punctuation" | "eof";
  readonly value: string;
}

class Parser {
  readonly #tokens: readonly Token[];
  #index = 0;
  readonly #maxStatements: number;
  readonly #maxNodes: number;
  readonly #maxDepth: number;
  #nodes = 0;
  #depth = 0;

  constructor(
    source: string,
    maxStatements: number,
    maxNodes: number,
    maxDepth: number,
  ) {
    this.#tokens = tokenize(source);
    this.#maxStatements = maxStatements;
    this.#maxNodes = maxNodes;
    this.#maxDepth = maxDepth;
  }

  parse(): Program {
    const statements: Statement[] = [];
    while (this.peek().kind !== "eof") {
      if (statements.length >= this.#maxStatements) {
        throw new RestrictedProgramError("Program statement limit exceeded.");
      }
      statements.push(this.parseStatement());
      this.consumeOptional(";");
      if (statements.at(-1)?.kind === "return" && !this.peek("eof")) {
        throw new RestrictedProgramError(
          "Statements after return are not allowed.",
        );
      }
    }
    if (statements.length === 0 || statements.at(-1)?.kind !== "return") {
      throw new RestrictedProgramError("Program must return a value.");
    }
    return statements;
  }

  parseStatement(): Statement {
    if (this.peekValue("const") || this.peekValue("let")) {
      this.advance();
      const name = this.expect("identifier").value;
      this.expectValue("=");
      return { kind: "binding", name, expression: this.parseExpression() };
    }
    if (this.peekValue("return")) {
      this.advance();
      return { kind: "return", expression: this.parseExpression() };
    }
    return { kind: "expression", expression: this.parseExpression() };
  }

  parseExpression(): Expression {
    this.#nodes += 1;
    if (this.#nodes > this.#maxNodes) {
      throw new RestrictedProgramError("Program node limit exceeded.");
    }
    if (this.peekValue("await")) {
      this.advance();
    }
    const token = this.peek();
    if (token.kind === "string") {
      this.advance();
      return { kind: "literal", value: token.value };
    }
    if (token.kind === "number") {
      this.advance();
      return { kind: "literal", value: Number(token.value) };
    }
    if (token.kind === "identifier") {
      this.advance();
      if (BLOCKED_NAMES.has(token.value)) {
        throw new RestrictedProgramError("Program uses a blocked capability.");
      }
      if (token.value === "true") return { kind: "literal", value: true };
      if (token.value === "false") return { kind: "literal", value: false };
      if (token.value === "null") return { kind: "literal", value: null };
      if (token.value === "undefined")
        return { kind: "literal", value: undefined };
      if (token.value === "tools") return this.parseToolCall();
      const path: string[] = [];
      while (this.consumeOptional(".")) {
        const property = this.expect("identifier").value;
        if (BLOCKED_NAMES.has(property)) {
          throw new RestrictedProgramError(
            "Program uses a blocked capability.",
          );
        }
        path.push(property);
      }
      return { kind: "variable", name: token.value, path };
    }
    if (this.consumeOptional("{")) {
      return this.withDepth(() => this.parseObject());
    }
    if (this.consumeOptional("[")) {
      return this.withDepth(() => this.parseArray());
    }
    if (this.consumeOptional("(")) {
      const expression = this.parseExpression();
      this.expectValue(")");
      return expression;
    }
    throw new RestrictedProgramError("Program contains unsupported syntax.");
  }

  withDepth<T>(callback: () => T): T {
    this.#depth += 1;
    if (this.#depth > this.#maxDepth) {
      throw new RestrictedProgramError("Program nesting limit exceeded.");
    }
    try {
      return callback();
    } finally {
      this.#depth -= 1;
    }
  }

  parseToolCall(): Expression {
    let name: string;
    if (this.consumeOptional(".")) {
      name = this.expect("identifier").value;
    } else if (this.consumeOptional("[")) {
      name = this.expect("string").value;
      this.expectValue("]");
    } else {
      throw new RestrictedProgramError("tools must select a named operation.");
    }
    if (BLOCKED_NAMES.has(name)) {
      throw new RestrictedProgramError("Program uses a blocked capability.");
    }
    this.expectValue("(");
    const argumentsList: Expression[] = [];
    if (!this.peekValue(")")) {
      do {
        argumentsList.push(this.parseExpression());
      } while (this.consumeOptional(","));
    }
    this.expectValue(")");
    return { kind: "call", name, arguments: argumentsList };
  }

  parseObject(): Expression {
    const entries: [string, Expression][] = [];
    if (!this.peekValue("}")) {
      do {
        const key = this.expect("identifier", "string").value;
        if (BLOCKED_NAMES.has(key)) {
          throw new RestrictedProgramError(
            "Program uses a blocked capability.",
          );
        }
        this.expectValue(":");
        entries.push([key, this.parseExpression()]);
      } while (this.consumeOptional(","));
    }
    this.expectValue("}");
    return { kind: "object", entries };
  }

  parseArray(): Expression {
    const items: Expression[] = [];
    if (!this.peekValue("]")) {
      do {
        items.push(this.parseExpression());
      } while (this.consumeOptional(","));
    }
    this.expectValue("]");
    return { kind: "array", items };
  }

  peek(kind?: Token["kind"]): Token {
    const token = this.#tokens[this.#index];
    if (kind && token.kind !== kind) {
      throw new RestrictedProgramError("Program contains malformed syntax.");
    }
    return token;
  }

  peekValue(value: string): boolean {
    return this.#tokens[this.#index]?.value === value;
  }

  advance(): Token {
    return this.#tokens[this.#index++];
  }

  consumeOptional(value: string): boolean {
    if (!this.peekValue(value)) return false;
    this.#index += 1;
    return true;
  }

  expect(...kinds: Token["kind"][]): Token {
    const token = this.advance();
    if (!kinds.includes(token.kind)) {
      throw new RestrictedProgramError("Program contains malformed syntax.");
    }
    return token;
  }

  expectValue(value: string): void {
    if (!this.consumeOptional(value)) {
      throw new RestrictedProgramError("Program contains malformed syntax.");
    }
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < source.length; ) {
    const character = source[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/u.test(source[index])) {
        index += 1;
      }
      tokens.push({ kind: "identifier", value: source.slice(start, index) });
      continue;
    }
    if (
      /[0-9]/u.test(character) ||
      (character === "-" && /[0-9]/u.test(source[index + 1] ?? ""))
    ) {
      const start = index;
      index += 1;
      while (index < source.length && /[0-9.eE+-]/u.test(source[index])) {
        index += 1;
      }
      const value = source.slice(start, index);
      if (
        !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(value)
      ) {
        throw new RestrictedProgramError("Program contains an invalid number.");
      }
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        throw new RestrictedProgramError("Program contains an invalid number.");
      }
      tokens.push({ kind: "number", value: String(numeric) });
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      index += 1;
      let value = "";
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          const escaped = source[index + 1];
          if (escaped === undefined)
            throw new RestrictedProgramError(
              "Program contains an unterminated string.",
            );
          const escapeMap: Record<string, string> = {
            "\\": "\\",
            '"': '"',
            "'": "'",
            n: "\n",
            r: "\r",
            t: "\t",
          };
          if (!(escaped in escapeMap))
            throw new RestrictedProgramError(
              "Program contains an unsupported escape.",
            );
          value += escapeMap[escaped];
          index += 2;
          continue;
        }
        value += source[index++];
      }
      if (source[index] !== quote)
        throw new RestrictedProgramError(
          "Program contains an unterminated string.",
        );
      index += 1;
      tokens.push({ kind: "string", value });
      continue;
    }
    if ("{}[]().,:;=".includes(character)) {
      tokens.push({ kind: "punctuation", value: character });
      index += 1;
      continue;
    }
    throw new RestrictedProgramError("Program contains unsupported syntax.");
  }
  tokens.push({ kind: "eof", value: "" });
  return tokens;
}
