import type { CallToolResult, StandardSchemaWithJSON } from "mcp-use";

/**
 * The small identity value that Gateway consumes from Platform.
 *
 * Platform remains the authority for credentials and identity. Gateway never
 * creates these values and never accepts an organization or profile supplied
 * by the program being executed.
 */
export interface AgentPrincipal {
  readonly kind: "agent";
  readonly agentId: string;
  readonly organizationId: string;
  readonly profileId: string;
}

export interface HumanPrincipal {
  readonly kind: "human";
  readonly userId: string;
  readonly organizationId: string;
}

/** Minimal Platform contract. A missing binding must fail closed. */
export interface PlatformIdentityVerifier {
  verifyAgentCredential(request: Request): Promise<AgentPrincipal | null>;
  verifyHumanSession(request: Request): Promise<HumanPrincipal | null>;
}

/** Gateway owns this grant store; an absent profile is distinct from no grants. */
export interface ProfileGrantStore {
  getGrantedOperationIds(
    organizationId: string,
    profileId: string,
  ): Promise<readonly string[] | null>;
}

/** The management permission is supplied by Platform or a trusted control plane. */
export interface ProfileManagementAuthorizer {
  canManageProfile(
    principal: HumanPrincipal,
    organizationId: string,
    profileId: string,
    request: Request,
  ): Promise<boolean>;
}

export interface ToolInvocationContext {
  readonly operationId: string;
  readonly signal: AbortSignal;
}

/**
 * Service-owned declarations are the only way an operation enters Gateway's
 * catalog. Gateway never derives tools from arbitrary service HTTP routes.
 */
export interface ServiceToolDeclaration {
  readonly operationId: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: StandardSchemaWithJSON;
  readonly outputSchema?: StandardSchemaWithJSON;
  readonly invoke: (
    principal: AgentPrincipal,
    input: Record<string, unknown>,
    context: ToolInvocationContext,
  ) => Promise<CallToolResult>;
}

export interface ServiceToolCatalog {
  getDeclarations(): Promise<readonly ServiceToolDeclaration[]>;
}

export type PublicToolDescription = Pick<
  ServiceToolDeclaration,
  "operationId" | "name" | "description"
>;

export const deniedToolCall = (
  message = "Tool access denied.",
): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

export const failedToolCall = (
  message = "Tool execution failed.",
): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

export function isAgentPrincipal(value: unknown): value is AgentPrincipal {
  if (value === null || typeof value !== "object") return false;
  const principal = value as Partial<AgentPrincipal>;
  return (
    principal.kind === "agent" &&
    nonEmpty(principal.agentId) &&
    nonEmpty(principal.organizationId) &&
    nonEmpty(principal.profileId)
  );
}

export function isHumanPrincipal(value: unknown): value is HumanPrincipal {
  if (value === null || typeof value !== "object") return false;
  const principal = value as Partial<HumanPrincipal>;
  return (
    principal.kind === "human" &&
    nonEmpty(principal.userId) &&
    nonEmpty(principal.organizationId)
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export class GatewayOperations {
  readonly #grantStore: ProfileGrantStore;
  readonly #catalogProvider: ServiceToolCatalog | null;
  readonly #toolsByName = new Map<string, ServiceToolDeclaration>();
  readonly #toolsById = new Map<string, ServiceToolDeclaration>();
  #catalogLoaded = false;
  #catalogLoading: Promise<void> | undefined;

  constructor(
    declarations: readonly ServiceToolDeclaration[] | ServiceToolCatalog,
    grantStore: ProfileGrantStore,
  ) {
    this.#grantStore = grantStore;
    this.#catalogProvider = Array.isArray(declarations)
      ? null
      : (declarations as ServiceToolCatalog);
    if (this.#catalogProvider) return;
    this.#replaceCatalog(declarations as readonly ServiceToolDeclaration[]);
  }

  async ensureCatalog(): Promise<void> {
    if (this.#catalogLoaded || !this.#catalogProvider) return;
    if (this.#catalogLoading) return this.#catalogLoading;
    this.#catalogLoading = (async () => {
      try {
        this.#replaceCatalog(await this.#catalogProvider!.getDeclarations());
      } catch {
        // A disconnected service removes only its own tools. Gateway remains
        // usable for health, discovery, and other configured services.
        this.#replaceCatalog([]);
        this.#catalogLoaded = false;
      } finally {
        this.#catalogLoading = undefined;
      }
    })();
    return this.#catalogLoading;
  }

  #replaceCatalog(declarations: readonly ServiceToolDeclaration[]): void {
    this.#toolsByName.clear();
    this.#toolsById.clear();
    for (const declaration of declarations) {
      if (
        !nonEmpty(declaration.operationId) ||
        !nonEmpty(declaration.name) ||
        this.#toolsByName.has(declaration.name) ||
        this.#toolsById.has(declaration.operationId)
      ) {
        throw new Error(
          "Service tool identifiers must be unique and non-empty.",
        );
      }
      this.#toolsByName.set(declaration.name, declaration);
      this.#toolsById.set(declaration.operationId, declaration);
    }
    this.#catalogLoaded = true;
  }

  catalog(): readonly ServiceToolDeclaration[] {
    return [...this.#toolsById.values()].sort((left, right) =>
      left.operationId.localeCompare(right.operationId),
    );
  }

  async discoverForAgent(
    principal: AgentPrincipal,
    organizationId: string,
    profileId: string,
  ): Promise<PublicToolDescription[]> {
    await this.ensureCatalog();
    if (
      principal.organizationId !== organizationId ||
      principal.profileId !== profileId
    ) {
      return [];
    }
    const grantedIds = await this.#grantStore.getGrantedOperationIds(
      organizationId,
      profileId,
    );
    if (!grantedIds) return [];
    const granted = new Set(grantedIds);
    return this.catalog()
      .filter((declaration) => granted.has(declaration.operationId))
      .map(({ operationId, name, description }) => ({
        operationId,
        name,
        description,
      }));
  }

  async searchForAgent(
    principal: AgentPrincipal,
    organizationId: string,
    profileId: string,
    query: string,
  ): Promise<PublicToolDescription[]> {
    const discovered = await this.discoverForAgent(
      principal,
      organizationId,
      profileId,
    );
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return discovered;
    return discovered.filter((tool) =>
      [tool.operationId, tool.name, tool.description].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    );
  }

  /**
   * Rechecks the grant immediately before every service call. This method is
   * also used by `use`, so a grant revoked between two program statements is
   * effective on the next statement.
   */
  async invokeForAgent(
    principal: AgentPrincipal,
    organizationId: string,
    profileId: string,
    toolName: string,
    input: Record<string, unknown>,
    context: ToolInvocationContext,
  ): Promise<CallToolResult> {
    if (context.signal.aborted) {
      return failedToolCall("Tool execution timed out.");
    }
    await this.ensureCatalog();
    if (context.signal.aborted) {
      return failedToolCall("Tool execution timed out.");
    }
    if (
      principal.organizationId !== organizationId ||
      principal.profileId !== profileId
    ) {
      return deniedToolCall(
        "Credential is not bound to this organization and profile.",
      );
    }

    const declaration = this.#toolsByName.get(toolName);
    if (!declaration) return deniedToolCall("Unknown Gateway operation.");

    const grantedIds = await this.#grantStore.getGrantedOperationIds(
      organizationId,
      profileId,
    );
    if (!grantedIds?.includes(declaration.operationId)) {
      return deniedToolCall();
    }

    const standard = declaration.inputSchema as {
      readonly "~standard"?: {
        readonly validate?: (value: unknown) =>
          | { readonly issues?: readonly unknown[]; readonly value?: unknown }
          | Promise<{
              readonly issues?: readonly unknown[];
              readonly value?: unknown;
            }>;
      };
    };
    let normalizedInput: Record<string, unknown>;
    try {
      const validate = standard["~standard"]?.validate;
      if (typeof validate !== "function") {
        return deniedToolCall("Invalid tool input.");
      }
      const validation = await validate(input);
      if (validation.issues?.length || !isRecord(validation.value)) {
        return deniedToolCall("Invalid tool input.");
      }
      normalizedInput = validation.value;
    } catch {
      return deniedToolCall("Invalid tool input.");
    }

    try {
      if (context.signal.aborted) {
        return failedToolCall("Tool execution timed out.");
      }
      return await declaration.invoke(principal, normalizedInput, context);
    } catch {
      return failedToolCall();
    }
  }

  async hasProfile(
    organizationId: string,
    profileId: string,
  ): Promise<boolean> {
    return (
      (await this.#grantStore.getGrantedOperationIds(
        organizationId,
        profileId,
      )) !== null
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
