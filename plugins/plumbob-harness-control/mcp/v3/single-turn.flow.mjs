import { acp, defineFlow } from 'acpx/flows';

export default defineFlow({
  name: 'codex-co-engineer-single-turn',
  startAt: 'delegate',
  nodes: {
    delegate: acp({
      prompt: ({ input }) => input.prompt,
    }),
  },
  edges: [],
});
