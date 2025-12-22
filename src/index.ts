import { Hono } from "hono";
import { cors } from "hono/cors";
import { stream } from "hono/streaming";
import {
  ChatCompletionsStreamResponse,
  convertClaudeRequestToOpenAI,
  convertOpenAINonStreamToClaude,
  convertOpenAIStreamToClaude,
  createStreamState,
  getFinalStreamEvents,
  handleOpenAIErrorResponse,
  TextResponse,
} from "./converters";
import { countClaudeTokens } from "./token";
import { writeLog, RequestLogEntry, getCurrentLogFilePath } from "./logger";

const copilotTokenCache = new Map<
  string,
  { token: string; expires_at: number }
>();

async function getCopilotToken(apiKey: string): Promise<string> {
  const cached = copilotTokenCache.get(apiKey);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expires_at > now + 60) {
    return cached.token;
  }

  const response = await fetch(
    "https://api.github.com/copilot_internal/v2/token",
    {
      method: "GET",
      headers: {
        Authorization: `token ${apiKey}`,
        "Editor-Version": "vscode/1.95.3",
        "Editor-Plugin-Version": "copilot-chat/0.26.7",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
        "X-Vscode-User-Agent-Library-Version": "electron-fetch",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to get Copilot token: ${response.statusText}`);
  }

  const data = (await response.json()) as { token: string; expires_at: number };
  const token = data.token;
  const expires_at = data.expires_at;
  copilotTokenCache.set(apiKey, { token, expires_at });
  return token;
}

const app = new Hono();

// Logging middleware
app.use("*", async (c, next) => {
  const startTime = Date.now();
  const method = c.req.method;
  const path = c.req.path;
  const url = new URL(c.req.url);

  // Collect request headers
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Try to get request body (if JSON)
  let body: any = undefined;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    try {
      const rawBody = await c.req.text();
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody; // Keep as string if not JSON
        }
        // Put body back for the actual handler
        c.req.raw = new Request(c.req.raw, { body: rawBody });
      }
    } catch (error) {
      console.error('Failed to read request body for logging:', error);
    }
  }

  const logEntry: RequestLogEntry = {
    timestamp: new Date().toISOString(),
    method,
    path,
    headers,
    body,
    query: url.search,
    ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
  };

  try {
    await next();

    // Log response status
    logEntry.responseStatus = c.res.status;
    logEntry.responseTime = Date.now() - startTime;
  } catch (error) {
    // Log error if request failed
    logEntry.error = error instanceof Error ? error.message : String(error);
    logEntry.responseTime = Date.now() - startTime;
    throw error;
  } finally {
    // Write log entry
    writeLog(logEntry);
  }
});

// CORS
app.use("*", cors());

function extractBaseUrl(
  path: string,
  endpoint: "/v1/messages" | "/v1/chat/completions",
): string {
  const baseUrl = path.replace(endpoint, "").substring(1);
  return baseUrl;
}

function isGeminiUrl(url: string): boolean {
  return url.includes("generativelanguage.googleapis.com");
}

function isCopilot(url: string): boolean {
  return url.includes("api.githubcopilot.com");
}

function isOpenAI(url: string): boolean {
  // return url.includes("api.openai.com");
  return url.includes("127.0.0.1:5000");
}

function getChatCompletionPath(baseUrl: string) {
  if (isGeminiUrl(baseUrl) || isCopilot(baseUrl)) {
    return "/chat/completions";
  }

  return "/v1/chat/completions";
}

async function handleClaudeToOpenAI(c: any) {
  try {
    const apiKey =
      c.req.header("x-api-key") ||
      c.req.header("authorization")?.replace("Bearer ", "");

    if (!apiKey) {
      return c.json(
        { error: { message: "Missing x-api-key or authorization header" } },
        400 as any,
      );
    }

    // Extract base URL from path (e.g., "generativelanguage.googleapis.com/v1beta/openai")
    const baseUrl = extractBaseUrl(c.req.path, "/v1/messages");

    if (!baseUrl) {
      return c.json(
        {
          error: {
            message:
              "Could not extract base URL from path. Format: /<base-url>/v1/messages",
          },
        },
        400 as any,
      );
    }

    // Parse request body
    const rawBody = await c.req.text();
    const claudeRequest = JSON.parse(rawBody);

    // Convert to OpenAI format

    const openaiRequest = convertClaudeRequestToOpenAI(claudeRequest);

    const targetUrl = `http://${baseUrl}${getChatCompletionPath(baseUrl)}`;

    console.log("targetUrl: ", targetUrl);

    // Forward to target API

    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (isCopilot(baseUrl)) {
      const realToken = await getCopilotToken(apiKey);
      requestHeaders["Copilot-Integration-Id"] = "vscode-chat";
      requestHeaders["Editor-Version"] = "vscode/1.95.3";
      requestHeaders["Editor-Plugin-Version"] = "copilot-chat/0.26.7";
      requestHeaders["User-Agent"] = `GitHubCopilotChat/0.26.7`;
      requestHeaders["Openai-Intent"] = "conversation-panel";
      requestHeaders["X-Github-Api-Version"] = "2025-04-01";
      requestHeaders["X-Request-Id"] = `${crypto.randomUUID()}`;
      requestHeaders["X-Vscode-User-Agent-Library-Version"] = "electron-fetch";
      requestHeaders["X-Initiator"] = "user";
      requestHeaders["Authorization"] = `Bearer ${realToken}`;
    } else {
      // Use appropriate auth header based on target API
      requestHeaders["Authorization"] = `Bearer ${apiKey}`;
    }

    const body = JSON.stringify(openaiRequest);

    const openAIResponse = await fetch(targetUrl, {
      method: "POST",
      headers: requestHeaders,
      body,
    });

    if (!openAIResponse.ok) {
      const claudeError = await handleOpenAIErrorResponse(openAIResponse);
      return c.json(claudeError, openAIResponse.status);
    }

    // Stream response
    if (openaiRequest.stream) {
      const state = createStreamState();
      c.header("Content-Type", "text/event-stream");

      return stream(c, async (streamWriter) => {
        const reader = openAIResponse.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalUsage = undefined;

        try {
          // 4. 循环读取 OpenAI 的流式响应
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]") continue;

                // 5. 解析 OpenAI chunk
                const openAIChunk: ChatCompletionsStreamResponse =
                  JSON.parse(data);

                // 6. 存储最后的 usage（用于最后发送）
                if (openAIChunk.usage) {
                  finalUsage = openAIChunk.usage;
                }

                // 7. 转换为 Claude 格式（核心函数！）
                const claudeEvents = convertOpenAIStreamToClaude(
                  openAIChunk,
                  state,
                );

                // 8. 立即发送给客户端（保持流式）
                for (const event of claudeEvents) {
                  await streamWriter.write(`event:${event.type}\n\n`);
                  await streamWriter.write(`data:${JSON.stringify(event)}\n\n`);
                }
              }
            }
          }

          // 9. 发送最后的结束事件
          const finalEvents = getFinalStreamEvents(state, finalUsage);
          for (const event of finalEvents) {
            await streamWriter.write(`event:${event.type}\n\n`);
            await streamWriter.write(`data:${JSON.stringify(event)}\n\n`);
          }

          // 10. 发送结束标记
          await streamWriter.write("data: [DONE]\n\n");
        } finally {
          await streamWriter.close();
        }
      });
    }

    // Non-streaming response

    const openAIResult = (await openAIResponse.json()) as TextResponse;

    const claudeResponse = convertOpenAINonStreamToClaude(openAIResult);
    return c.json(claudeResponse, openAIResponse.status as any);
  } catch (error: any) {
    console.log("Internal server error: ", error);
    return c.json(
      { error: { message: `Internal server error: ${error.message}` } },
      500 as any,
    );
  }
}

const handleCountTokens = async (c: any) => {
  try {
    const body = await c.req.json();

    // 验证必填字段
    if (!body.model || !body.messages) {
      return c.json({ error: "model and messages are required" }, 400);
    }

    // 计算token数
    const tokenCount = countClaudeTokens({
      model: body.model,
      messages: body.messages,
      system: body.system,
      tools: body.tools,
    });

    // 返回Claude格式响应
    return c.json({
      input_tokens: tokenCount,
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
};

const handleCountTokensDetailed = async (c: any) => {
  const body = await c.req.json();

  const tokenCount = countClaudeTokens({
    model: body.model,
    messages: body.messages,
    system: body.system,
    tools: body.tools,
  });

  return c.json({
    input_tokens: tokenCount,
    model: body.model,
    message_count: body.messages?.length || 0,
    has_tools: !!body.tools,
    has_system: !!body.system,
  });
};

app.post("*", async (c) => {
  const path = c.req.path;
  if (path.endsWith("/v1/messages")) {
    return handleClaudeToOpenAI(c);
  } else if (path.endsWith("/v1/messages/count_tokens")) {
    return handleCountTokens(c);
  } else if (path.endsWith("/v1/messages/count_tokens/detailed")) {
    return handleCountTokensDetailed(c);
  } else if (path.endsWith("/v1/messages/test-conversion")) {
    // Test endpoint to see the converted OpenAI format
    try {
      const claudeRequest = await c.req.json();
      const openaiRequest = convertClaudeRequestToOpenAI(claudeRequest);
      return c.json({
        original: claudeRequest,
        converted: openaiRequest,
        note: "This shows the conversion result without sending to OpenAI"
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  } else {
    return c.json(
      { error: "Endpoint not supported. Use /v1/messages for Claude format" },
      404,
    );
  }
});

// ============================================================================
// Health check and utilities
// ============================================================================

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

app.get("/logs/info", (c) => {
  const logPath = getCurrentLogFilePath();
  return c.json({
    message: "Request logging is active",
    currentLogFile: logPath,
    note: "All requests are being logged to the file above"
  });
});

export default app;
