import { z } from 'zod';

export const instructionFileSchema = z.object({ path: z.string(), kind: z.enum(['managed', 'user', 'project', 'local', 'memory']), content: z.string(), parent: z.string().optional(), isUnverified: z.literal(true).optional() });
export type InstructionFile = z.infer<typeof instructionFileSchema>;
export const instructionPromptSchema = z.object({ files: z.array(instructionFileSchema).readonly(), prefix: z.string(), suffix: z.string(), empty: z.string() });
export type InstructionPrompt = z.infer<typeof instructionPromptSchema>;
