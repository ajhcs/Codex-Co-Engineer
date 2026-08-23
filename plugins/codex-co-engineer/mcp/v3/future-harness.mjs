// P22 Future-harness public index.
//
// Re-exports the inert ProviderDriverV1 template/scaffold. This file is not
// a P17 registry, supervisor cutover, or fifth provider. Future harnesses
// import this surface or the template module directly.

export {
  FUTURE_HARNESS_BRANCH_PATTERN,
  FUTURE_HARNESS_FAIL_CLOSED_FEATURES,
  FUTURE_HARNESS_IDENTITY_KEYS,
  FUTURE_HARNESS_REQUEST_ID_PATTERN,
  FUTURE_HARNESS_TEMPLATE_OPTION_KEYS,
  FUTURE_HARNESS_TEMPLATE_SCHEMA_ID,
  FUTURE_HARNESS_TEMPLATE_VERSION,
  bindFutureHarnessDriverTemplateV1,
  createFutureHarnessDriverTemplateV1,
  describeFutureHarnessDriverTemplateV1,
  inspectFutureHarnessTemplateBindingV1,
  validateFutureHarnessIdentityV1,
} from './provider-driver-template.mjs';
