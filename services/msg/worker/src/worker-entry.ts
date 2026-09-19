export { ConversationRoom } from "./conversation-room";
import { D1OperationStore, type D1DatabaseLike } from "./operations";
import { DurableRoomService, type RoomNamespace } from "./room-service";
import { createMsgAuthenticator, parseOperatorAllowlist, unavailableMsgAuthenticator, type MsgRoomAuthPort } from "./auth";
import { createWorker, type MsgEnvironment, type MsgRateLimit } from "./worker";

export interface MsgProductionEnvironment extends MsgEnvironment {
  readonly MSG_TEST_MODE?: string;
  readonly MSG_CREATE_DISABLED?: string;
  readonly MSG_DATA_ENCRYPTION_KEY_V1?: string;
  readonly MSG_DB?: D1DatabaseLike;
  readonly MSG_PLATFORM_BASE_URL?: string;
  readonly MSG_PLATFORM_AUTHORITY?: string;
  readonly MSG_PLATFORM_AUDIENCE?: string;
  readonly MSG_PLATFORM_SERVICE_VERIFIER?: string;
  readonly MSG_PLATFORM_GUEST_GRANT_ISSUER?: string;
  readonly MSG_OPERATOR_ALLOWLIST?: string;
  readonly MSG_POST_DISABLED?: string;
  readonly MSG_PUBLIC_ORIGIN?: string;
  readonly MSG_RATE_LIMIT_CREATION?: MsgRateLimit;
  readonly MSG_RATE_LIMIT_READS?: MsgRateLimit;
  readonly MSG_RATE_LIMIT_POSTS?: MsgRateLimit;
  readonly MSG_RATE_LIMIT_LIVE?: MsgRateLimit;
}

export default {
  fetch(request: Request, env: MsgProductionEnvironment): Promise<Response> {
    const roomService = env.ROOM_SERVICE ?? (env.ConversationRoom ? new DurableRoomService(env.ConversationRoom as RoomNamespace, env.MSG_PUBLIC_ORIGIN ?? "https://msg.0000.chat") : undefined);
    if (!roomService) return createWorker(
      { async create() { throw new Error("The room service is not available."); } },
      { assets: env.ASSETS },
    ).fetch(request);
    const operations = env.MSG_DB && env.MSG_DATA_ENCRYPTION_KEY_V1
      ? new D1OperationStore(env.MSG_DB, env.MSG_DATA_ENCRYPTION_KEY_V1)
      : undefined;
    const accessPort = roomService && roomService.proveLink && roomService.recordGrant && roomService.checkGrant ? roomService as MsgRoomAuthPort : undefined;
    const auth = env.MSG_TEST_MODE === "1"
      ? undefined
      : accessPort && env.MSG_PLATFORM_BASE_URL && env.MSG_PLATFORM_AUTHORITY && env.MSG_PLATFORM_AUDIENCE && env.MSG_PLATFORM_SERVICE_VERIFIER && env.MSG_PLATFORM_GUEST_GRANT_ISSUER
      ? createMsgAuthenticator({
        baseUrl: env.MSG_PLATFORM_BASE_URL,
        authority: env.MSG_PLATFORM_AUTHORITY,
        audience: env.MSG_PLATFORM_AUDIENCE,
        serviceVerifier: env.MSG_PLATFORM_SERVICE_VERIFIER,
        guestGrantIssuer: env.MSG_PLATFORM_GUEST_GRANT_ISSUER,
        operatorAllowlist: parseOperatorAllowlist(env.MSG_OPERATOR_ALLOWLIST),
      }, accessPort)
      : unavailableMsgAuthenticator();
    return createWorker(roomService, {
      assets: env.ASSETS,
      auth,
      createDisabled: env.MSG_CREATE_DISABLED === "1",
      operations,
      postDisabled: env.MSG_POST_DISABLED === "1",
      rateLimits: {
        creation: env.MSG_RATE_LIMIT_CREATION,
        live: env.MSG_RATE_LIMIT_LIVE,
        posts: env.MSG_RATE_LIMIT_POSTS,
        reads: env.MSG_RATE_LIMIT_READS,
      },
    }).fetch(request);
  },
  scheduled(_event: ScheduledEvent, env: MsgProductionEnvironment, ctx: ExecutionContext): void {
    if (!env.MSG_DB || !env.MSG_DATA_ENCRYPTION_KEY_V1) return;
    const operations = new D1OperationStore(env.MSG_DB, env.MSG_DATA_ENCRYPTION_KEY_V1);
    ctx.waitUntil((async () => {
      for (let batch = 0; batch < 10; batch += 1) {
        if (await operations.purgeExpired() === 0) return;
      }
    })());
  },
};
