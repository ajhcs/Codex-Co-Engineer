const PACKAGE_NAME = '@deepseek-ai/dsh-acp-demo';
const name = 'acp-demo-invariant';
const inject = ['invariants'];
const install = () => {};
const apply = (context) => Promise.resolve(context.invariants.register(PACKAGE_NAME, install));
export { apply, inject, name };
