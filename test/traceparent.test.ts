import { describe, it, expect } from "bun:test";
import { parseTraceparent } from "../src/proxy/traceparent";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

describe("parseTraceparent", () => {
  it("parses a valid traceparent header", () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01`)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
    });
  });

  it("accepts unsampled flags and trims whitespace", () => {
    expect(parseTraceparent(`  00-${TRACE_ID}-${SPAN_ID}-00  `)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
    });
  });

  it("accepts future versions other than ff", () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01`)).not.toBeNull();
  });

  it("rejects version ff", () => {
    expect(parseTraceparent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeNull();
  });

  it("rejects all-zero trace id and span id", () => {
    expect(parseTraceparent(`00-${"0".repeat(32)}-${SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${"0".repeat(16)}-01`)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent("")).toBeNull();
    expect(parseTraceparent("not-a-traceparent")).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID.slice(0, 30)}-${SPAN_ID}-01`)).toBeNull();
  });
});
