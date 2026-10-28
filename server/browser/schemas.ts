// Shapes shared by the MCP server (which validates them) and the run pipeline (which reads them).
import { z } from 'zod';
import type { BrowserSession, SessionConfig } from './session.js';

export type AgentMode = 'plan' | 'execute' | 'cleanup';

export interface McpConfig extends SessionConfig {
  mode: AgentMode;
}

export const PlanSchema = z.object({
  features: z.array(z.object({ name: z.string(), description: z.string() })).describe('Every feature/control group found on the page'),
  testCases: z.array(z.object({
    title: z.string(),
    category: z.string().describe('One of: functional, validation, negative, search, navigation, uploads, content'),
    priority: z.enum(['high', 'medium', 'low']),
    preconditions: z.string(),
    steps: z.string().describe('Numbered steps, one per line'),
    expected: z.string().describe('Concrete, checkable expected result'),
    testData: z.string(),
  })),
});
export type PlanOutput = z.infer<typeof PlanSchema>;

export const ResultSchema = z.object({
  status: z.enum(['passed', 'failed', 'blocked']).describe('failed = the site did not behave as expected; blocked = you could not carry out the steps'),
  actual: z.string().describe('What actually happened, in one or two sentences'),
  bug: z.object({
    title: z.string(),
    severity: z.enum(['critical', 'major', 'minor', 'trivial']),
    expected: z.string(),
    actual: z.string(),
  }).optional().describe('Required when status is failed'),
  notes: z.string().optional(),
});
export type ResultOutput = z.infer<typeof ResultSchema>;

export interface AgentState {
  performed: BrowserSession['performed'];
  recording: BrowserSession['recording'];
  replayable: boolean;
  result?: ResultOutput;
  plan?: PlanOutput;
  screenshot?: string;
  consoleErrors: string[];
}
