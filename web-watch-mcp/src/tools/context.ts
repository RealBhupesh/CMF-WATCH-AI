import { z } from "zod";

export const browserContextFields = {
  taskId: z.uuid().optional().describe("Bind this call to a saved task's session. Does not replay steps or mark them complete; checkpoint progress explicitly."),
  sessionId: z.string().min(1).optional().describe("Persistent session ID from browser_sessions; defaults to default"),
  tabId: z.uuid().optional().describe("Stable tab ID from browser_tabs or a snapshot. Closed/restarted tab IDs fail; they never select another tab."),
};
