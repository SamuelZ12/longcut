## 2025-05-23 - [Input Clear Button Pattern]
**Learning:** Users often struggle to clear long inputs like URLs. Adding a conditional "Clear" button (X icon) that appears when text is present significantly improves usability on both desktop and mobile.
**Action:** When creating primary text inputs (search, URL), always implement a clear button that:
1. Only appears when input has value
2. Clears the state
3. Returns focus to the input element

## 2025-05-23 - [Component Cleanup]
**Learning:** Found an unused component `UrlInputWithBranding` that was a near-duplicate of `UrlInput`.
**Action:** Before modifying a component, check for duplicates or "with branding" variants that might be unused. remove them to keep the codebase clean.
