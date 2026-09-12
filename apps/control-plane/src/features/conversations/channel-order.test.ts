import { beforeEach, describe, expect, it } from "vitest";
import {
  applyChannelOrder,
  loadChannelOrder,
  moveChannel,
  saveChannelOrder,
} from "./channel-order";

describe("channel order preferences", () => {
  beforeEach(() => sessionStorage.clear());

  it("scopes order to principal plus identity", () => {
    saveChannelOrder("principal_pilot", "identity_human", [
      "connection_human_telegram",
      "connection_human_whatsapp",
    ]);
    expect(loadChannelOrder("principal_pilot", "identity_human")).toEqual([
      "connection_human_telegram",
      "connection_human_whatsapp",
    ]);
    expect(loadChannelOrder("principal_pilot", "identity_agent")).toEqual([]);
  });

  it("returns an empty order for malformed storage", () => {
    sessionStorage.setItem("communicator:channel-order:principal_pilot:identity_human", "not-json");
    expect(loadChannelOrder("principal_pilot", "identity_human")).toEqual([]);
  });

  it("applies preferred order and keeps unknown channels in server order", () => {
    const channels = [
      { id: "connection_a", sort_position: 20 },
      { id: "connection_b", sort_position: 10 },
      { id: "connection_c", sort_position: 30 },
    ];
    expect(applyChannelOrder(channels, ["connection_a"])).toEqual([
      channels[0],
      channels[1],
      channels[2],
    ]);
  });

  it("swaps only an in-range channel", () => {
    expect(moveChannel(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveChannel(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
  });
});
