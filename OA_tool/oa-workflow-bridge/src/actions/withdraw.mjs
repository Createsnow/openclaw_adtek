import { OAClientError } from "../oa-client.mjs";
import {
  alreadyWithdrawnCard,
  WITHDRAW_INACTIVE,
  WITHDRAW_NOT_FOUND,
  WITHDRAW_NOTHING,
  withdrawChooseCard,
  WITHDRAWING,
  withdrawDeniedCard,
  withdrawFailedCard,
  withdrawnCard,
  withdrawUnknownCard,
} from "../reply.mjs";
import { getTicketByRequestId, listWithdrawableTickets, updateTicket, withSenderLock } from "../store.mjs";
import { fail, maybeCleanup } from "./common.mjs";

/** 同进程里正在撤销的单：并发的第二次撤销直接回「正在撤销」，不再打 OA。 */
const inflightWithdrawals = new Set();

/** OA 明确说没权限：多半是处理人已经办理，或流程节点不允许删除。 */
const DENIED_CODES = new Set(["NO_PERMISSION"]);

function normalizeRequestId(value) {
  if (value === undefined || value === null || value === "") return "";
  const text = String(value).replace(/\s+/g, "");
  if (!/^\d{1,18}$/.test(text)) fail("INVALID_REQUEST_ID", "requestId must be the digits of an OA request number");
  return text;
}

/**
 * 找要撤销的那张单。只在此人自己经小A提交过的单里找，别人的单号一律当查不到。
 * 返回 `{ ticket }` 或 `{ reply }`（不调 OA，直接回员工）。
 */
async function pickTicket(store, identity, requestId) {
  if (requestId) {
    const ticket = await getTicketByRequestId(store, identity, requestId);
    if (!ticket) return { reply: { ok: false, code: "WITHDRAW_NOT_FOUND", requestId, replyZh: WITHDRAW_NOT_FOUND } };
    if (ticket.status === "withdrawn") {
      return { reply: { ok: true, code: "ALREADY_WITHDRAWN", requestId, replyZh: alreadyWithdrawnCard({ requestId }) } };
    }
    if (ticket.status !== "submitted") {
      return { reply: { ok: false, code: "WITHDRAW_NOT_FOUND", requestId, replyZh: WITHDRAW_NOT_FOUND } };
    }
    return { ticket };
  }
  const { total, tickets } = await listWithdrawableTickets(store, identity);
  if (!total) return { reply: { ok: false, code: "NOTHING_TO_WITHDRAW", replyZh: WITHDRAW_NOTHING } };
  if (total > 1) {
    const requestIds = tickets.map((ticket) => ticket.requestId);
    return {
      reply: {
        ok: false,
        code: "WITHDRAW_CHOOSE",
        withdrawableCount: total,
        withdrawable: requestIds.map((id) => ({ requestId: id })),
        replyZh: withdrawChooseCard({ total, requestIds }),
      },
    };
  }
  return { ticket: tickets[0] };
}

function failurePayload(error, requestId) {
  const code = error instanceof OAClientError ? error.code : "OA_ERROR";
  if (error?.ambiguous || /^HTTP_5\d\d$/.test(code) || code === "INVALID_RESPONSE") {
    return { ok: false, code: "WITHDRAW_OUTCOME_UNKNOWN", oaCode: code, requestId, replyZh: withdrawUnknownCard({ requestId }) };
  }
  if (DENIED_CODES.has(code)) {
    return { ok: false, code: "WITHDRAW_DENIED", oaCode: code, requestId, replyZh: withdrawDeniedCard({ requestId }) };
  }
  return { ok: false, code: "WITHDRAW_REJECTED", oaCode: code, requestId, replyZh: withdrawFailedCard({ requestId }) };
}

/**
 * 撤销此人已提交到 OA 的工单：调 OA deleteRequest 删除该流程，不可恢复。
 * - 带 requestId：只认此人自己经小A提交的单。
 * - 不带：只有一张已提交的单就撤那张；多张则列出最近几张请员工回单号。
 * 默认以申请人身份按流程权限删除；`OA_WITHDRAW_AS_MONITOR=true` 时以接口账号的监控权限删除。
 * 删除失败不改本地状态（仍是 submitted），员工可以再试；只有 OA 回 SUCCESS 才记 withdrawn（= 已从 OA 删除）。
 */
export async function withdraw({ store, stateDir, config, trust, params, logger, deps }) {
  const requestedId = normalizeRequestId(params.requestId);
  const picked = await withSenderLock(trust.identity, () => pickTicket(store, trust.identity, requestedId));
  if (picked.reply) return picked.reply;

  const { ticket } = picked;
  const requestId = ticket.requestId;
  if (!config.active) {
    return { ok: false, code: "OA_BRIDGE_INACTIVE", requestId, replyZh: WITHDRAW_INACTIVE };
  }
  if (inflightWithdrawals.has(ticket.confirmationId)) {
    return { ok: false, code: "WITHDRAWING", requestId, replyZh: WITHDRAWING };
  }

  inflightWithdrawals.add(ticket.confirmationId);
  try {
    const client = deps.clientFactory(config);
    try {
      const started = Date.now();
      await client.deleteRequest(requestId, {
        operatorUserId: ticket.oaRequesterId,
        asMonitor: config.withdrawAsMonitor === true,
      });
      logger?.info?.(`[oa-workflow-bridge] withdraw deleteRequest elapsedMs=${Date.now() - started} requestId=${requestId}`);
    } catch (error) {
      logger?.warn?.(`[oa-workflow-bridge] withdraw failed requestId=${requestId} code=${error?.code || "UNKNOWN"}`);
      return failurePayload(error, requestId);
    }
    try {
      await withSenderLock(trust.identity, () => updateTicket(store, ticket.confirmationId, {
        status: "withdrawn",
        expectStatus: "submitted",
      }));
    } catch (error) {
      // OA 已删除，本地没记上：仍按成功回员工，台账留 submitted，对账时以 OA 为准。
      logger?.warn?.(`[oa-workflow-bridge] OA deleted requestId=${requestId} but local persist failed: ${error?.message || error}`);
    }
  } finally {
    inflightWithdrawals.delete(ticket.confirmationId);
  }
  await maybeCleanup(store, stateDir);
  return { ok: true, code: "WITHDRAWN", requestId, replyZh: withdrawnCard({ requestId }) };
}
