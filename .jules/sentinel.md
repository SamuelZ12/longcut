## 2024-05-23 - [IDOR in Newsletter Unsubscribe]
**Vulnerability:** The unsubscribe endpoint `/api/newsletter/unsubscribe` accepted a JSON payload with `userId` and directly unsubscribed that user without any authentication or signature verification.
**Learning:** Manual scripts that generate public links (like email newsletters) often skip standard security practices (like authentication) because they are "internal tools", but the resulting links expose public endpoints.
**Prevention:** Always require a cryptographic signature (HMAC) for any action performed via a public link that acts on a specific user's data without a session.
