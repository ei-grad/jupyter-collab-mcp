# Repository agent instructions

## Defect-derived specification

- After reproducing a defect, add the smallest normative invariant to `SPEC.md`
  that would prevent an independent reimplementation from repeating it.
- Keep the specification about observable behavior and constraints; do not add
  incident history, debugging narration, or details of the chosen patch.
- Add a regression test for the invariant. When the defect crosses an external
  boundary such as Jupyter RTC, kernels, persistence, or the browser, also
  verify that boundary with the real integration fixture.

## Skill maintenance

- Whenever a tool interface or behavior changes, update `skill/SKILL.md` in the
  same change so its workflow, safety and recovery guidance, and examples match
  the current contract. Do not merge a tool change with stale skill
  instructions.
