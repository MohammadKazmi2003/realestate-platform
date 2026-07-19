"""
Real-world chatbot query tester.
Sends actual queries to the chatbot endpoint and evaluates responses.
"""

import asyncio
import aiohttp
import json
import time
import uuid

BASE_URL = "http://localhost:8000"

# ============================================================
# 100+ REAL CHATBOT QUERIES
# ============================================================

QUERIES = [
    # === BASIC SEARCH (20) ===
    "show me 2bhk in dubai",
    "show me 2bhk in dubai under 200k",
    "find apartments in pune",
    "i want a villa in bangalore",
    "show me 3bhk in delhi",
    "looking for a flat in mumbai",
    "any properties in hyderabad",
    "show me homes in abu dhabi",
    "find apartments in sharjah",
    "show me properties in gurgaon",
    "i need a house in noida",
    "find me a flat in chennai",
    "show me apartments in kolkata",
    "looking for property in ahmedabad",
    "show me homes in jaipur",
    "find property in lucknow",
    "show me apartments in goa",
    "find homes in chandigarh",
    "show me properties in dehradun",
    "looking for flat in indore",

    # === BUDGET FILTERS (20) ===
    "show me 2bhk in dubai under 200k",
    "find apartments under 50 lakhs",
    "show me properties under 1 crore",
    "i want a home under 2 crores",
    "show me apartments under 500k",
    "find villas under 3 crores",
    "show me 2bhk under 100k",
    "looking for property between 50 lakhs and 1 crore",
    "show me homes between 1 and 2 crores",
    "find apartments between 100k and 300k",
    "show me properties above 5 crores",
    "find homes between 200k and 500k",
    "show me apartments between 50l and 1cr",
    "looking for property under 75 lakhs",
    "show me flats under 150k",
    "find villas between 1cr and 3cr",
    "show me homes above 2 crores",
    "find apartments between 300k and 600k",
    "show me properties under 40 lakhs",
    "looking for homes between 80l and 1.5cr",

    # === BEDROOM FILTERS (15) ===
    "show me 1bhk in dubai",
    "find 2bhk apartments in pune",
    "show me 3bhk homes in delhi",
    "looking for 4bhk villa in bangalore",
    "show me 5bhk property in mumbai",
    "find 2bhk flat in dubai under 200k",
    "show me 3bhk in sharjah under 500k",
    "looking for 1bhk apartment in abu dhabi",
    "show me 4bhk home in pune",
    "find 2bhk in hyderabad under 1cr",
    "show me 3bhk apartment in delhi under 2cr",
    "looking for 5bhk villa in dubai",
    "show me 1bhk flat in mumbai under 50l",
    "find 2bhk in bangalore between 50l and 1cr",
    "show me 3bhk house in chennai",

    # === PROPERTY TYPE FILTERS (15) ===
    "show me apartments in dubai",
    "find villas in pune",
    "looking for a plot in delhi",
    "show me commercial property in mumbai",
    "find independent house in bangalore",
    "show me flats in hyderabad",
    "looking for a bungalow in dubai",
    "show me residential apartments in sharjah",
    "find villa in abu dhabi under 500k",
    "show me apartment in pune under 1cr",
    "looking for plot in gurgaon",
    "find commercial space in mumbai",
    "show me land in delhi",
    "looking for house in chennai",
    "find villa in kochi",

    # === NAME SEARCH (15) ===
    "tell me about sobha hartland",
    "show me azure heights",
    "search for DLF crest",
    "find citrus county properties",
    "show me prestige towers",
    "looking for emerald greens",
    "tell me about lake view heights",
    "search for skyline residences",
    "find harmony heights",
    "show me royal palm estate",
    "looking for golden gate plaza",
    "tell me about silver oak villas",
    "find green valley apartments",
    "search for crystal court",
    "show me ivory towers",

    # === PROJECT SEARCH (10) ===
    "show meVerdana projects",
    "find sobha properties",
    "looking for azizi developments",
    "show me emaar projects",
    "find damac properties",
    "show me nakheel projects",
    "looking for meraas developments",
    "find binghatti properties",
    "show me omniyat projects",
    "looking for reportage developments",

    # === SEMANTIC / CONCEPTUAL (10) ===
    "i want a luxury apartment with pool",
    "find me a family home near schools",
    "show me modern office space",
    "looking for affordable studio apartment",
    "i need a quiet residential area",
    "find beachfront property",
    "show me gated community with gym",
    "looking for pet friendly apartment",
    "find high rise with city view",
    "show me spacious villa with garden",

    # === FOLLOW-UP / CONVERSATIONAL (10) ===
    "tell me more about the first one",
    "what about the second property",
    "can you show me more options",
    "what is the price of the first listing",
    "do you have anything cheaper",
    "show me page 2",
    "what amenities does it have",
    "is there parking available",
    "can i schedule a visit",
    "what is the area size",
]

# Expected tool for each query category
EXPECTED_TOOLS = {
    "show me 2bhk in dubai": "structured_property_search",
    "tell me about sobha hartland": "full_text_property_search",
    "findVerdana projects": "project_text_search",
    "i want a luxury apartment with pool": "semantic_property_search",
    "tell me more about the first one": "respond_to_user",
}


async def send_query(session, query, session_id):
    """Send a chatbot query and return the response."""
    payload = {
        "messages": [{"role": "user", "content": query}],
        "session_state": {},
        "session_id": session_id,
    }
    try:
        async with session.post(f"{BASE_URL}/api/chat", json=payload, timeout=aiohttp.ClientTimeout(total=60)) as resp:
            if resp.status == 200:
                data = await resp.json()
                return {
                    "status": "ok",
                    "text": data.get("text_response", ""),
                    "properties": data.get("properties", []),
                    "has_properties": len(data.get("properties", [])) > 0,
                    "session_state": data.get("session_state", {}),
                }
            else:
                text = await resp.text()
                return {"status": "error", "text": text[:200], "has_properties": False}
    except Exception as e:
        return {"status": "error", "text": str(e)[:200], "has_properties": False}


def evaluate_response(query, response):
    """Evaluate if a response is reasonable."""
    text = response.get("text", "")
    has_props = response.get("has_properties", False)
    status = response.get("status", "error")

    if status == "error":
        return "ERROR", response["text"]

    # Check if response is meaningful
    if not text or len(text) < 10:
        return "FAIL", "Response too short or empty"

    # Check if search queries got properties
    is_search = any(kw in query.lower() for kw in ["show", "find", "search", "looking", "want", "2bhk", "3bhk", "apartment", "villa", "flat"])
    is_detail = any(kw in query.lower() for kw in ["tell me more", "what about", "price", "amenities", "area"])

    if is_search and not has_props:
        if "not sure" in text.lower() or "don't have" in text.lower() or "no properties" in text.lower():
            return "WARN", "No properties found (may be data issue)"
        return "FAIL", "Search query but no properties returned"

    if is_detail and has_props:
        return "WARN", "Detail query returned properties instead of details"

    # Check for generic error responses
    if "error" in text.lower() and len(text) < 50:
        return "FAIL", "Appears to be an error message"

    return "PASS", text[:100]


async def main():
    print(f"Testing {len(QUERIES)} real chatbot queries...\n")

    results = []
    session_id = str(uuid.uuid4())

    async with aiohttp.ClientSession() as session:
        for idx, query in enumerate(QUERIES, 1):
            start = time.time()
            response = await send_query(session, query, session_id)
            elapsed = time.time() - start

            evaluation, detail = evaluate_response(query, response)
            has_props = response.get("has_properties", False)
            prop_count = len(response.get("properties", []))

            results.append({
                "idx": idx,
                "query": query,
                "evaluation": evaluation,
                "detail": detail,
                "has_properties": has_props,
                "prop_count": prop_count,
                "time": elapsed,
                "response_preview": response.get("text", "")[:80],
            })

            icon = {"PASS": "✓", "FAIL": "✗", "WARN": "⚠", "ERROR": "✗"}.get(evaluation, "?")
            props_str = f" [{prop_count} props]" if has_props else ""
            print(f"  {idx:3d}. {icon} [{evaluation:5s}] {query[:45]:45s}{props_str:10s} {elapsed:.1f}s")

    # Summary
    passed = sum(1 for r in results if r["evaluation"] == "PASS")
    warned = sum(1 for r in results if r["evaluation"] == "WARN")
    failed = sum(1 for r in results if r["evaluation"] == "FAIL")
    errored = sum(1 for r in results if r["evaluation"] == "ERROR")
    total = len(results)

    print(f"\n{'='*70}")
    print(f"RESULTS: {passed} PASS, {warned} WARN, {failed} FAIL, {errored} ERROR / {total} total")
    print(f"PASS RATE: {passed/total*100:.1f}%")
    print(f"AVG TIME: {sum(r['time'] for r in results)/total:.1f}s")

    # List failures
    failures = [r for r in results if r["evaluation"] in ("FAIL", "ERROR")]
    if failures:
        print(f"\nFAILURES ({len(failures)}):")
        for r in failures:
            print(f"  {r['idx']:3d}. {r['query'][:50]:50s} → {r['detail']}")
            print(f"      Response: {r['response_preview']}")

    warnings = [r for r in results if r["evaluation"] == "WARN"]
    if warnings:
        print(f"\nWARNINGS ({len(warnings)}):")
        for r in warnings:
            print(f"  {r['idx']:3d}. {r['query'][:50]:50s} → {r['detail']}")

    # Save results
    with open("chatbot_test_results.json", "w") as f:
        json.dump({"total": total, "passed": passed, "warned": warned, "failed": failed, "errored": errored, "results": results}, f, indent=2)
    print(f"\nResults saved to chatbot_test_results.json")


if __name__ == "__main__":
    asyncio.run(main())
