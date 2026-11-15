// Test-only switch: the legacy opaque staff tokens ("dispatcher-demo" …) are accepted so the older tests stay short.
// In a real run they are OFF and staff must log in for a JWT (see test/security.test.js, which runs with them off).
process.env.ALLOW_STATIC_TOKENS = '1';
