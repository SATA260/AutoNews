import { z } from 'zod';

/** 节目可使用的四位主播标识。 */
export const HostMascotIdSchema = z.enum(['deepseek', 'gpt', 'gemini', 'claude']);
/** 节目主播标识类型。 */
export type HostMascotId = z.infer<typeof HostMascotIdSchema>;

/** 主播的阵营、语气和示例配置。 */
export const PersonaProfileSchema = z.object({
  id: HostMascotIdSchema,
  displayName: z.string().min(1),
  campKeywords: z.array(z.string().min(1)).min(1),
  topicKeywords: z.array(z.string().min(1)).min(1),
  themeAccent: z.string().min(1),
  coreTrait: z.string().min(1),
  speakingStyle: z.string().min(1),
  stanceGuide: z.string().min(1),
  introExamples: z.array(z.string().min(1)).min(1),
  outroExamples: z.array(z.string().min(1)).min(1),
  forbiddenTokens: z.array(z.string().min(1)),
});
/** 主播配置类型。 */
export type PersonaProfile = z.infer<typeof PersonaProfileSchema>;

/** 校验配置中四位主播各出现一次。 */
export const PersonasFileSchema = z.object({
  personas: z
    .array(PersonaProfileSchema)
    .length(4)
    .refine(
      (personas) => new Set(personas.map((persona) => persona.id)).size === 4,
      '必须分别配置四位主播',
    ),
});
