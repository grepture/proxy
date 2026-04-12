/**
 * Realistic text blocks with known PII for detector tests.
 * Each export documents the expected matches.
 */

/** Contains one of each PII category (except name). */
export const MIXED_PII_TEXT =
  "Contact John at john.doe@example.com or call (555) 123-4567. " +
  "SSN: 123-45-6789. Card: 4111 1111 1111 1111. " +
  "Server IP: 192.168.1.100. " +
  "Office: 123 Main Street. " +
  "DOB: 01/15/1990.";

export const MIXED_PII_EXPECTED = {
  email: "john.doe@example.com",
  phone: "(555) 123-4567",
  ssn: "123-45-6789",
  credit_card: "4111 1111 1111 1111",
  ip_address: "192.168.1.100",
  address: "123 Main Street",
  date_of_birth: "01/15/1990",
};

/** No PII at all. */
export const CLEAN_TEXT =
  "The weather today is sunny with a high of 75 degrees. " +
  "Please review the quarterly report and submit your feedback.";

/** Contains potential false positives. */
export const FALSE_POSITIVE_TEXT =
  "Version 1.2.3.4 was released. " +
  "Order #1234567890 has shipped. " +
  "The meeting is at 3:00 PM.";

/** Contains overlapping PII patterns. */
export const OVERLAPPING_TEXT =
  "SSN 123-45-6789 and DOB 01/15/1990 belong to the same person.";

/** A JSON body with PII embedded in message content. */
export const JSON_BODY_WITH_PII = JSON.stringify({
  model: "gpt-4",
  messages: [
    {
      role: "user",
      content: "My email is alice@example.com and my phone is 555-987-6543.",
    },
  ],
});
