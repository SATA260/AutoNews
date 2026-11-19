import { z } from 'zod';

/** 节目可使用的四位主播标识。 */
export const HostMascotIdSchema = z.enum(['deepseek', 'gpt', 'gemini', 'claude']);
/** 节目主播标识类型。 */
export type HostMascotId = z.infer<typeof HostMascotIdSchema>;

/** 主播的所属背景、人设档案、阵营反应、自称、语气和示例配置 */
export const PersonaProfileSchema = z.object({
  id: HostMascotIdSchema,
  selfName: z.string().min(1),
  displayName: z.string().min(1),
  affiliation: z.string().min(1),
  identityBio: z.string().min(1),
  campKeywords: z.array(z.string().min(1)).min(1),
  topicKeywords: z.array(z.string().min(1)).min(1),
  themeAccent: z.string().min(1),
  coreTrait: z.string().min(1),
  speakingStyle: z.string().min(1),
  roastStyle: z.string().min(1).optional(),
  stanceGuide: z.string().min(1),
  ownGoodReaction: z.string().min(1),
  ownFlawReaction: z.string().min(1),
  rivalReaction: z.string().min(1),
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
