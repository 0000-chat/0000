export { ConversationRoom } from "./conversation-room";
import { D1OperationStore, type D1DatabaseLike } from "./operations";
import { DurableRoomService, type RoomNamespace } from "./room-service";
import { createWorker, type MsgEnvironment, type MsgRateLimit } from "./worker";

export interface MsgProductionEnvironment extends MsgEnvironment {
  readonly MSG_CREATE_DISABLED?: string;
  readonly MSG_DATA_ENCRYPTION_KEY_V1?: string;
  readonly MSG_DB?: D1DatabaseLike;
  readonly MSG_OPERATOR_TOKEN?: string;
  readonly MSG_POST_DISABLED?: string;
  readonly MSG_PUBLIC_ORIGIN?: string;
  readonly MSG_RATE_LIMIT_CREATION?: MsgRateLimit;
  readonly MSG_RATE_LIMIT_READS?: MsgRateLimit;
  readonly MSG_RATE_LIMIT_POSTS?: MsgRateLimit;
  readonly MSG_RATE_LIMIT_LIVE?: MsgRateLimit;
  readonly MSG_VAPID_PUBLIC_KEY?: string;
  readonly MSG_VAPID_PRIVATE_KEY?: string;
  readonly MSG_VAPID_SUBJECT?: string;
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
    const pushConfigured = Boolean(env.MSG_VAPID_PUBLIC_KEY && env.MSG_VAPID_PRIVATE_KEY && env.MSG_VAPID_SUBJECT);
    return createWorker(roomService, {
      assets: env.ASSETS,
      createDisabled: env.MSG_CREATE_DISABLED === "1",
      operations,
      operatorToken: env.MSG_OPERATOR_TOKEN,
      postDisabled: env.MSG_POST_DISABLED === "1",
      publicOrigin: env.MSG_PUBLIC_ORIGIN,
      pushConfigured,
      pushVapidPublicKey: pushConfigured ? env.MSG_VAPID_PUBLIC_KEY : undefined,
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
