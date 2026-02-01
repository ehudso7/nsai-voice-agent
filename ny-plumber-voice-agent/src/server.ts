import Fastify from "fastify";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import twilio from "twilio";
import { z } from "zod";
import process from "node:process";
import { randomUUID } from "node:crypto";

import {
  RealtimeAgent,
  RealtimeSession,
  backgroundResult,
  tool
} from "@openai/agents/realtime";

import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";
import { appendLead, appendEvent } from "./leadStore.js";

dotenv.config();

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const PORT = Number(process.env.PORT || 5050);
const PUBLIC_HOST = process.env.PUBLIC_HOST; // recommended
const BUSINESS_NAME = process.env.BUSINESS_NAME || "NY Plumbing (Pilot)";
const ONCALL_PHONE = mustEnv("ONCALL_PHONE");
const OPENAI_API_KEY = mustEnv("OPENAI_API_KEY");

// Twilio SMS is strongly recommended for the pilot.
// (If you leave these blank, tools will still "work" but won't actually send texts.)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

function assertE164(phone: string) {
  if (!phone.startsWith("+") || phone.length < 11) {
    throw new Error(`Phone must be E.164 format like +15551234567`);
  }
}

/**
 * Tools (keep them minimal for pilot)
 */
const createLeadTool = tool({
  name: "create_lead",
  description:
    "Create a new plumbing service lead from call details. Use after collecting address, issue, urgency, and callback number.",
  parameters: z.object({
    callerPhone: z.string().optional(),
    callerName: z.string().optional(),
    serviceAddress: z.string().optional(),
    issue: z.string().optional(),
    urgency: z.enum(["low", "normal", "emergency"]).default("normal"),
    preferredTime: z.string().optional(),
    notes: z.string().optional()
  }),
  execute: async (input) => {
    const id = randomUUID();
    const lead = {
      id,
      createdAt: new Date().toISOString(),
      businessName: BUSINESS_NAME,
      ...input,
      source: "twilio_call" as const
    };

    appendLead(lead);

    // backgroundResult keeps internal IDs/logging out of the spoken response.
    return backgroundResult(`Lead stored with id ${id}`);
  }
});

const sendSmsTool = tool({
  name: "send_sms_to_number",
  description:
    "Send an informational SMS confirmation (never promotional). Use after caller confirms they can receive a text.",
  parameters: z.object({
    to: z.string().describe("E.164 phone number, e.g. +15551234567"),
    message: z.string().max(480)
  }),
  execute: async ({ to, message }) => {
    assertE164(to);

    appendEvent({ type: "sms_attempt", to, messagePreview: message.slice(0, 80) });

    if (!twilioClient || !TWILIO_FROM_NUMBER) {
      return backgroundResult("Twilio not configured; SMS skipped.");
    }

    const res = await twilioClient.messages.create({
      from: TWILIO_FROM_NUMBER,
      to,
      body: `${message}\n\nReply STOP to opt out.`
    });

    return backgroundResult(`SMS sent: sid=${res.sid}`);
  }
});

const escalateTool = tool({
  name: "escalate_to_oncall",
  description:
    "Escalate an emergency lead to the on-call person via SMS (and optionally a call in later versions).",
  parameters: z.object({
    callerPhone: z.string().optional(),
    serviceAddress: z.string().optional(),
    issue: z.string().optional(),
    reason: z.string().default("emergency")
  }),
  execute: async ({ callerPhone, serviceAddress, issue, reason }) => {
    appendEvent({ type: "escalation", reason, callerPhone, serviceAddress, issue });

    if (!twilioClient || !TWILIO_FROM_NUMBER) {
      return backgroundResult("Twilio not configured; escalation SMS skipped.");
    }

    const body =
      `🚨 EMERGENCY LEAD (${BUSINESS_NAME})\n` +
      `Reason: ${reason}\n` +
      (issue ? `Issue: ${issue}\n` : "") +
      (serviceAddress ? `Address: ${serviceAddress}\n` : "") +
      (callerPhone ? `Caller: ${callerPhone}\n` : "");

    const res = await twilioClient.messages.create({
      from: TWILIO_FROM_NUMBER,
      to: ONCALL_PHONE,
      body
    });

    return backgroundResult(`Escalation SMS sent: sid=${res.sid}`);
  }
});

const logSummaryTool = tool({
  name: "log_call_summary",
  description: "Log the final call summary for internal tracking.",
  parameters: z.object({
    summary: z.string().max(2000)
  }),
  execute: async ({ summary }) => {
    appendEvent({ type: "call_summary", summary });
    return backgroundResult("Summary logged.");
  }
});

/**
 * Agent instructions (pilot-safe)
 */
const agent = new RealtimeAgent({
  name: "NY Plumber Intake Agent",
  instructions: `
You are the after-hours receptionist for ${BUSINESS_NAME}, a plumbing service in New York.
Your job is to (1) capture the lead, (2) escalate emergencies, (3) confirm next steps.

Rules:
- Be concise. Ask one question at a time.
- Never ask for SSN, credit cards, or payment info.
- Do NOT give exact prices. If asked, say: "Pricing depends on the situation; a technician will confirm after diagnosing."
- If the caller reports flooding, burst pipe, sewage backup, or gas smell, treat as EMERGENCY.
- Always collect: callback number, address (or nearest cross streets), and a short issue description.
- If you plan to text them, ask: "Can I text you a confirmation at this number?"
- Use tools:
  - create_lead after you have the basics.
  - escalate_to_oncall if emergency.
  - send_sms_to_number for confirmation (informational only).
  - log_call_summary at the end.

Opening script:
- Inform them: "This call may be recorded for quality and service."
- Then: "How can we help you tonight?"
`.trim(),
  tools: [createLeadTool, escalateTool, sendSmsTool, logSummaryTool]
});

const fastify = Fastify({ logger: true });
await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

/**
 * Health
 */
fastify.get("/", async () => ({
  ok: true,
  service: "ny-plumber-voice-agent",
  time: new Date().toISOString()
}));

/**
 * Twilio Voice webhook (TwiML)
 * This tells Twilio to open a bidirectional Media Stream websocket to /media-stream.
 */
fastify.all("/incoming-call", async (request, reply) => {
  const host = PUBLIC_HOST || String(request.headers.host);
  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>This call may be recorded for quality and service.</Say>
  <Say>OK, you can start talking.</Say>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>
`.trim();

  reply.type("text/xml").send(twiml);
});

/**
 * Media Stream websocket route
 * Bridges Twilio Media Streams <-> OpenAI Realtime via TwilioRealtimeTransportLayer.
 */
fastify.register(async (scoped) => {
  scoped.get("/media-stream", { websocket: true }, async (connection) => {
    const twilioTransport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: connection
    });

    const session = new RealtimeSession(agent, {
      transport: twilioTransport,
      model: "gpt-realtime",
      config: {
        audio: { output: { voice: "verse" } }
      }
    });

    session.on("transport_event", (evt: any) => {
      // Useful if you need raw Twilio events for debugging.
      // Twilio sends: connected, start, media, stop, etc.
      appendEvent({ type: "transport_event", evtType: evt?.type || "unknown" });
    });

    session.on("error", (err: unknown) => {
      appendEvent({ type: "session_error", err: String(err) });
    });

    // Connect ASAP (the docs are explicit about speed).
    await session.connect({ apiKey: OPENAI_API_KEY });
    appendEvent({ type: "realtime_connected" });
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Listening at ${address}`);
});
