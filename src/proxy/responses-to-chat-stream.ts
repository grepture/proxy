/**
 * Transforms a Responses API SSE stream into Chat Completions SSE format.
 *
 * Cursor sends to /v1/chat/completions and expects Chat Completions SSE back,
 * but newer models use the Responses API. This transform bridges the gap so
 * Cursor can render the response.
 */
export function createResponsesToChatStream(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sseBuffer = "";
  let responseId = "responses-compat";

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sseBuffer += decoder.decode(chunk, { stream: true });

      const parts = sseBuffer.split("\n\n");
      sseBuffer = parts.pop()!;

      for (const block of parts) {
        const trimmed = block.trim();
        if (!trimmed) continue;

        // Parse event type and data
        let eventType = "";
        let dataLine = "";
        for (const line of trimmed.split("\n")) {
          if (line.startsWith("event: ")) eventType = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataLine = line.slice(6).trim();
        }

        if (!dataLine || dataLine === "[DONE]") continue;

        let json: Record<string, unknown>;
        try { json = JSON.parse(dataLine); } catch { continue; }

        // Grab response ID from the first event
        if (json.response && typeof (json.response as Record<string, unknown>).id === "string") {
          responseId = (json.response as Record<string, unknown>).id as string;
        }

        if (eventType === "response.output_text.delta" && typeof json.delta === "string") {
          const chunk = JSON.stringify({
            id: responseId,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: json.delta }, finish_reason: null }],
          });
          controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        } else if (eventType === "response.completed" || eventType === "response.done") {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        // All other events (response.created, response.in_progress, etc.) are dropped
      }
    },

    flush(controller) {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });

  return upstream.pipeThrough(transform);
}
