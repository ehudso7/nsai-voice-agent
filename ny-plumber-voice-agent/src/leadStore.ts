import fs from "node:fs";
import path from "node:path";

export type Lead = {
  id: string;
  createdAt: string;
  businessName: string;
  callerPhone?: string;
  callerName?: string;
  serviceAddress?: string;
  issue?: string;
  urgency?: "low" | "normal" | "emergency";
  preferredTime?: string;
  notes?: string;
  source?: "twilio_call";
};

const DATA_DIR = path.join(process.cwd(), "data");
const LEADS_FILE = path.join(DATA_DIR, "leads.jsonl");

export function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, "");
}

export function appendLead(lead: Lead) {
  ensureDataDir();
  fs.appendFileSync(LEADS_FILE, JSON.stringify(lead) + "\n", "utf8");
}

export function appendEvent(event: Record<string, unknown>) {
  ensureDataDir();
  fs.appendFileSync(
    path.join(DATA_DIR, "events.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n",
    "utf8"
  );
}
