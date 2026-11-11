import { addAbortListener } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createCodingAgent } from "./agent.mjs";

export const fireworksModels = [
  ["kimi-k3p1-pro", "Kimi K3.1 Pro"],
  ["glm-5p3", "GLM-5.3"],
  ["deepseek-v4p1-flash", "DeepSeek V4.1 Flash"],
].map(([slug, name]) => ({ id: `accounts/fireworks/models/${slug}`, name }));

export const fireworksDefinition = {
  id: "fireworks",
  name: "Fireworks AI",
  description: "Runs the coding councils, agents, and workspace chat.",
  fields: [{ id: "apiKey", label: "API key", placeholder: "fw_…", env: "FIREWORKS_API_KEY" }],
};

function convertMessages(messages) {
  return messages.flatMap(({ role, content }) => {
    if (typeof content === "string") return [{ role, content }];
    if (role === "user") return content.map(block => ({
      role: "tool", tool_call_id: block.tool_use_id, content: block.content,
    }));
    const toolCalls = content.filter(block => block.type === "tool_use").map(block => ({
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: block.arguments },
    }));
    const reasoning = content.find(block => block.type === "reasoning");
    return [{
      role,
      content: content.filter(block => block.type === "text").map(block => block.text).join("") || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(reasoning ? { reasoning_content: reasoning.text } : {}),
    }];
  });
}

function retryDelay(header, attempt) {
  if (header && /^\d+(?:\.\d+)?$/u.test(header)) {
    const milliseconds = Number(header) * 1000;
    if (milliseconds < 8.64e15 - Date.now()) return milliseconds;
  }
  const retryAt = Date.parse(header || "");
  if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  return 3000 * 2 ** (attempt - 1);
}

async function waitForSlot(slots, signal) {
  let listener;
  const abort = new Promise((_, reject) => {
    listener = addAbortListener(signal, () => reject(signal.reason));
  });
  try {
    await Promise.race([...slots, abort]);
  } finally {
    listener[Symbol.dispose]();
  }
}

export function createFireworks({ getKey, record, fetcher = fetch }) {
  const defaultModel = fireworksModels[0].id;
  const traffic = new Map();

  function capacity() {
    return [...traffic].flatMap(([model, { cooldown }]) =>
      cooldown?.until > Date.now() ? [{ model, ...cooldown, until: new Date(cooldown.until).toISOString() }] : []);
  }

  async function send(operation, runId, signal, { model, system, messages, tools, max_tokens }, structured, attempt) {
    const key = getKey();
    if (!key) throw new Error("Add a Fireworks AI API key in Settings.");
    const reasoningEffort = {
      [fireworksModels[0].id]: "low",
      [fireworksModels[1].id]: tools ? 1536 : 768,
      [fireworksModels[2].id]: tools ? "low" : "none",
    }[model];
    const event = { provider: "fireworks", operation, runId, model, attempt };
    const modelTraffic = traffic.get(model) || { slots: new Set(), consecutiveTimeouts: 0 };
    traffic.set(model, modelTraffic);
    const { slots } = modelTraffic;
    let release;
    let slot;
    let started;
    try {
      while (true) {
        signal.throwIfAborted();
        const wait = (modelTraffic.cooldown?.until || 0) - Date.now();
        if (wait > 0) await delay(Math.min(wait, 2_147_483_647), undefined, { signal });
        else if (slots.size >= 2) await waitForSlot(slots, signal);
        else break;
      }
      slot = new Promise(resolve => { release = resolve; });
      slots.add(slot);
      started = Date.now();
      const response = await fetcher("https://api.fireworks.ai/inference/v1/chat/completions", {
        method: "POST",
        redirect: "error",
        signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: structured || tools ? Math.max(max_tokens, tools ? 8192 : 3072) : max_tokens,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          messages: [{ role: "system", content: system }, ...convertMessages(messages)],
          ...(structured ? { response_format: { type: "json_object" } } : {}),
          ...(tools ? { tools: tools.map(tool => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
          })) } : {}),
        }),
      });
      if (!response.ok) {
        const reason = { 400: "request rejected", 401: "invalid API key", 402: "account credit required",
          403: "access denied", 404: "model unavailable", 429: "rate limit exceeded", 503: "service overloaded" }[response.status];
        const error = new Error(`Fireworks HTTP ${response.status}${reason ? ` (${reason})` : ""}.`);
        error.httpStatus = response.status;
        if (response.status === 429 || response.status === 503) {
          error.retryable = true;
          const until = Date.now() + retryDelay(response.headers.get("retry-after"), attempt);
          if (until >= (modelTraffic.cooldown?.until || 0)) {
            modelTraffic.cooldown = { until, reason: response.status === 429 ? "Rate limited" : "Service overloaded" };
          }
        }
        await response.body?.cancel().catch(() => {});
        throw error;
      }
      const result = await response.json();
      modelTraffic.consecutiveTimeouts = 0;
      const { message, finish_reason: finishReason } = result.choices?.[0] ?? {};
      if (!message) throw new Error("Fireworks returned no completion.");
      const usage = { input_tokens: result.usage?.prompt_tokens, output_tokens: result.usage?.completion_tokens };
      const metrics = [["Input tokens", usage.input_tokens], ["Output tokens", usage.output_tokens],
        ["Cache read tokens", result.usage?.prompt_tokens_details?.cached_tokens]]
        .filter(([, value]) => Number.isFinite(value)).map(([label, value]) => ({ label, value, unit: "tokens" }));
      record({ ...event, status: "success", durationMs: Date.now() - started, detail: result.model || model, metrics });
      const content = [];
      if (message.content) content.push({ type: "text", text: message.content });
      if (message.reasoning_content) content.push({ type: "reasoning", text: message.reasoning_content });
      for (const call of message.tool_calls || []) {
        let input;
        try { input = JSON.parse(call.function.arguments); } catch { input = null; }
        content.push({ type: "tool_use", id: call.id, name: call.function.name, input, arguments: call.function.arguments });
      }
      return { content, usage, stop_reason: finishReason === "stop" ? "end_turn" : finishReason };
    } catch (error) {
      const timedOut = signal.reason?.name === "TimeoutError";
      const detail = signal.aborted ? (slot ? "Fireworks request timed out or was cancelled." :
        "The request deadline passed while waiting for Fireworks capacity.") :
        error.message.startsWith("Fireworks ") ? error.message : "Could not complete the Fireworks request.";
      if (slot) {
        if (timedOut && ++modelTraffic.consecutiveTimeouts >= 2) {
          const until = Date.now() + 15000;
          if (until >= (modelTraffic.cooldown?.until || 0)) modelTraffic.cooldown = { until, reason: "Repeated request timeouts" };
        }
        record({ ...event, status: "failed", durationMs: Date.now() - started, detail,
          httpStatus: error.httpStatus, ...(timedOut ? { timedOut: true } : {}) });
      }
      throw Object.assign(new Error(detail), { retryable: error.retryable });
    } finally {
      if (slot) {
        slots.delete(slot);
        release();
      }
    }
  }

  async function complete(operation, runId, signal, body, { structured = false } = {}) {
    const request = { model: defaultModel, ...body };
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await send(operation, runId, signal, request, structured, attempt);
      } catch (error) {
        if (!error.retryable || signal.aborted || attempt === 3) throw error;
      }
    }
  }

  async function test() {
    if (!getKey()) return { status: "unavailable", detail: "Add a Fireworks AI API key." };
    const results = await Promise.allSettled(fireworksModels.map(({ id: model }) => complete(
      "Verify model connection", undefined, AbortSignal.timeout(25000), {
        model, system: "Reply with OK.", messages: [{ role: "user", content: "Connection check." }], max_tokens: 1024,
      })));
    const failed = results.flatMap((result, index) => result.status === "rejected"
      ? [`${fireworksModels[index].name}: ${result.reason.message}`] : []);
    return failed.length ? { status: "error", detail: failed.join(" ") }
      : { status: "connected", detail: "All three default Fireworks models responded." };
  }

  async function chat(system, messages) {
    const result = await complete("Workspace chat", undefined, AbortSignal.timeout(75000), {
      system, messages, max_tokens: 3072,
    }, { structured: true });
    return JSON.parse(result.content.find(block => block.type === "text")?.text || "");
  }

  return { test, chat, capacity, agent: createCodingAgent(complete, defaultModel) };
}
