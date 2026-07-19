"""
Comprehensive chatbot test suite.
Tests 100+ real-world user queries against the search services.
"""

import asyncio
import sys
import time
import json

sys.path.insert(0, ".")

from api_py.services.property_search import PropertySearchService, StructuredSearchParams
from api_py.services.property_details import PropertyDetailsService
from api_py.shared.text_utils import format_property_summary, format_property_details

search = PropertySearchService()
details = PropertyDetailsService()

# ============================================================
# TEST QUERIES - 100+ real-world user queries
# ============================================================

TESTS = [
    # === STRUCTURED SEARCH: Location only (20 tests) ===
    ("structured", {"location": "Dubai"}, "Location Dubai"),
    ("structured", {"location": "Pune"}, "Location Pune"),
    ("structured", {"location": "Delhi"}, "Location Delhi"),
    ("structured", {"location": "Bangalore"}, "Location Bangalore"),
    ("structured", {"location": "Mumbai"}, "Location Mumbai"),
    ("structured", {"location": "Hyderabad"}, "Location Hyderabad"),
    ("structured", {"location": "Abu Dhabi"}, "Location Abu Dhabi"),
    ("structured", {"location": "Sharjah"}, "Location Sharjah"),
    ("structured", {"location": "Gurgaon"}, "Location Gurgaon"),
    ("structured", {"location": "Noida"}, "Location Noida"),
    ("structured", {"location": "Chennai"}, "Location Chennai"),
    ("structured", {"location": "Kolkata"}, "Location Kolkata"),
    ("structured", {"location": "Ahmedabad"}, "Location Ahmedabad"),
    ("structured", {"location": "Jaipur"}, "Location Jaipur"),
    ("structured", {"location": "Lucknow"}, "Location Lucknow"),
    ("structured", {"location": "Indore"}, "Location Indore"),
    ("structured", {"location": "Kochi"}, "Location Kochi"),
    ("structured", {"location": "Goa"}, "Location Goa"),
    ("structured", {"location": "Dehradun"}, "Location Dehradun"),
    ("structured", {"location": "Chandigarh"}, "Location Chandigarh"),

    # === STRUCTURED SEARCH: Bedrooms only (15 tests) ===
    ("structured", {"bedrooms": 1}, "1 BHK"),
    ("structured", {"bedrooms": 2}, "2 BHK"),
    ("structured", {"bedrooms": 3}, "3 BHK"),
    ("structured", {"bedrooms": 4}, "4 BHK"),
    ("structured", {"bedrooms": 5}, "5 BHK"),

    # === STRUCTURED SEARCH: Property type only (10 tests) ===
    ("structured", {"property_type": "apartment"}, "Type apartment"),
    ("structured", {"property_type": "villa"}, "Type villa"),
    ("structured", {"property_type": "plot"}, "Type plot"),
    ("structured", {"property_type": "commercial"}, "Type commercial"),
    ("structured", {"property_type": "land"}, "Type land"),

    # === STRUCTURED SEARCH: Price range (15 tests) ===
    ("structured", {"max_price": 5000000}, "Under 50L"),
    ("structured", {"max_price": 10000000}, "Under 1Cr"),
    ("structured", {"max_price": 20000000}, "Under 2Cr"),
    ("structured", {"max_price": 50000000}, "Under 5Cr"),
    ("structured", {"min_price": 1000000, "max_price": 5000000}, "10L-50L"),
    ("structured", {"min_price": 5000000, "max_price": 10000000}, "50L-1Cr"),
    ("structured", {"min_price": 10000000, "max_price": 20000000}, "1Cr-2Cr"),
    ("structured", {"min_price": 20000000, "max_price": 50000000}, "2Cr-5Cr"),
    ("structured", {"min_price": 50000000}, "Above 5Cr"),

    # === STRUCTURED SEARCH: Combined filters (30 tests) ===
    ("structured", {"location": "Dubai", "bedrooms": 2}, "Dubai 2BHK"),
    ("structured", {"location": "Dubai", "bedrooms": 3}, "Dubai 3BHK"),
    ("structured", {"location": "Dubai", "bedrooms": 1}, "Dubai 1BHK"),
    ("structured", {"location": "Dubai", "bedrooms": 4}, "Dubai 4BHK"),
    ("structured", {"location": "Pune", "bedrooms": 2}, "Pune 2BHK"),
    ("structured", {"location": "Pune", "bedrooms": 3}, "Pune 3BHK"),
    ("structured", {"location": "Delhi", "bedrooms": 2}, "Delhi 2BHK"),
    ("structured", {"location": "Delhi", "bedrooms": 3}, "Delhi 3BHK"),
    ("structured", {"location": "Bangalore", "bedrooms": 2}, "Bangalore 2BHK"),
    ("structured", {"location": "Mumbai", "bedrooms": 3}, "Mumbai 3BHK"),
    ("structured", {"location": "Hyderabad", "bedrooms": 2}, "Hyderabad 2BHK"),
    ("structured", {"location": "Dubai", "property_type": "apartment"}, "Dubai apartment"),
    ("structured", {"location": "Dubai", "property_type": "villa"}, "Dubai villa"),
    ("structured", {"location": "Pune", "property_type": "apartment"}, "Pune apartment"),
    ("structured", {"location": "Bangalore", "property_type": "villa"}, "Bangalore villa"),
    ("structured", {"location": "Dubai", "bedrooms": 2, "max_price": 5000000}, "Dubai 2BHK under 50L"),
    ("structured", {"location": "Dubai", "bedrooms": 2, "max_price": 10000000}, "Dubai 2BHK under 1Cr"),
    ("structured", {"location": "Dubai", "bedrooms": 3, "min_price": 10000000}, "Dubai 3BHK above 1Cr"),
    ("structured", {"location": "Pune", "bedrooms": 2, "max_price": 10000000}, "Pune 2BHK under 1Cr"),
    ("structured", {"location": "Delhi", "bedrooms": 3, "max_price": 20000000}, "Delhi 3BHK under 2Cr"),
    ("structured", {"location": "Dubai", "min_price": 1000000, "max_price": 3000000}, "Dubai 10L-30L"),
    ("structured", {"location": "Dubai", "min_price": 5000000, "max_price": 10000000}, "Dubai 50L-1Cr"),
    ("structured", {"location": "Pune", "min_price": 5000000, "max_price": 15000000}, "Pune 50L-1.5Cr"),
    ("structured", {"location": "Abu Dhabi", "bedrooms": 2}, "Abu Dhabi 2BHK"),
    ("structured", {"location": "Sharjah", "bedrooms": 2}, "Sharjah 2BHK"),
    ("structured", {"location": "Dubai", "bedrooms": 2, "property_type": "apartment"}, "Dubai 2BHK apartment"),
    ("structured", {"location": "Pune", "bedrooms": 3, "property_type": "apartment"}, "Pune 3BHK apartment"),
    ("structured", {"location": "Delhi", "bedrooms": 2, "property_type": "villa"}, "Delhi 2BHK villa"),
    ("structured", {"location": "Mumbai", "bedrooms": 2, "max_price": 30000000}, "Mumbai 2BHK under 3Cr"),
    ("structured", {"location": "Hyderabad", "bedrooms": 3, "min_price": 5000000}, "Hyderabad 3BHK above 50L"),

    # === TEXT SEARCH (20 tests) ===
    ("text", "Sobha Hartland", "Text: Sobha Hartland"),
    ("text", "Azure Heights", "Text: Azure Heights"),
    ("text", "DLF Crest", "Text: DLF Crest"),
    ("text", "Citrus County", "Text: Citrus County"),
    ("text", "Prestige Towers", "Text: Prestige Towers"),
    ("text", "Emerald Greens", "Text: Emerald Greens"),
    ("text", "Lake View Heights", "Text: Lake View Heights"),
    ("text", "Skyline Residences", "Text: Skyline Residences"),
    ("text", "Harmony Heights", "Text: Harmony Heights"),
    ("text", "Royal Palm Estate", "Text: Royal Palm Estate"),
    ("text", "Golden Gate Plaza", "Text: Golden Gate Plaza"),
    ("text", "Silver Oak Villas", "Text: Silver Oak Villas"),
    ("text", "Green Valley Apartments", "Text: Green Valley Apartments"),
    ("text", "Crystal Court", "Text: Crystal Court"),
    ("text", "Maple Enclave", "Text: Maple Enclave"),
    ("text", "Ivory Towers", "Text: Ivory Towers"),
    ("text", "The Serenity", "Text: The Serenity"),
    ("text", "Suncity Gardens", "Text: Suncity Gardens"),
    ("text", "Oasis Retreat", "Text: Oasis Retreat"),
    ("text", "Blossom Fields", "Text: Blossom Fields"),

    # === PROJECT SEARCH (10 tests) ===
    ("project", "Verdana", "Project: Verdana"),
    ("project", "Sobha", "Project: Sobha"),
    ("project", "Azizi", "Project: Azizi"),
    ("project", "Emaar", "Project: Emaar"),
    ("project", "Damac", "Project: Damac"),
    ("project", "Nakheel", "Project: Nakheel"),
    ("project", "Meraas", "Project: Meraas"),
    ("project", "Binghatti", "Project: Binghatti"),
    ("project", "Omniyat", "Project: Omniyat"),
    ("project", "Reportage", "Project: Reportage"),

    # === SEMANTIC SEARCH (10 tests) ===
    ("semantic", "luxury apartment with pool", "Semantic: luxury pool"),
    ("semantic", "family home near school", "Semantic: family school"),
    ("semantic", "modern office space", "Semantic: modern office"),
    ("semantic", "affordable studio apartment", "Semantic: affordable studio"),
    ("semantic", "quiet residential area", "Semantic: quiet residential"),
    ("semantic", "beachfront property", "Semantic: beachfront"),
    ("semantic", "gated community with gym", "Semantic: gated gym"),
    ("semantic", "pet friendly apartment", "Semantic: pet friendly"),
    ("semantic", "high rise with city view", "Semantic: high rise view"),
    ("semantic", "spacious villa with garden", "Semantic: spacious garden"),
]


async def run_test(idx, test_type, params, label):
    """Run a single test and return result."""
    start = time.time()
    try:
        if test_type == "structured":
            result = await search.structured_search(StructuredSearchParams(**params))
        elif test_type == "text":
            result = await search.text_search(params)
        elif test_type == "project":
            result = await search.search_projects(params)
        elif test_type == "semantic":
            result = await search.semantic_search(params)
        else:
            return {"idx": idx, "label": label, "status": "SKIP", "count": 0, "time": 0}

        elapsed = time.time() - start
        count = len(result)
        status = "PASS" if count > 0 else "FAIL"

        # Check for formatter issues
        if count > 0:
            summary = format_property_summary(result[:1])
            has_title = "Title:" in summary and "None" not in summary.split("Title:")[1].split(",")[0]
            if not has_title:
                status = "WARN"

        return {"idx": idx, "label": label, "status": status, "count": count, "time": elapsed}
    except Exception as e:
        elapsed = time.time() - start
        return {"idx": idx, "label": label, "status": "ERROR", "count": 0, "time": elapsed, "error": str(e)}


async def main():
    print(f"Running {len(TESTS)} tests...\n")

    results = []
    for idx, (test_type, params, label) in enumerate(TESTS, 1):
        result = await run_test(idx, test_type, params, label)
        results.append(result)

        icon = {"PASS": "✓", "FAIL": "✗", "WARN": "⚠", "ERROR": "✗", "SKIP": "-"}.get(result["status"], "?")
        count_str = f"{result['count']} results" if result["count"] > 0 else "0 results"
        time_str = f"{result['time']:.2f}s"
        print(f"  {idx:3d}. {icon} [{result['status']:5s}] {result['label']:40s} {count_str:12s} {time_str}")

    # Summary
    passed = sum(1 for r in results if r["status"] == "PASS")
    warned = sum(1 for r in results if r["status"] == "WARN")
    failed = sum(1 for r in results if r["status"] == "FAIL")
    errored = sum(1 for r in results if r["status"] == "ERROR")
    total = len(results)

    print(f"\n{'='*60}")
    print(f"RESULTS: {passed} PASS, {warned} WARN, {failed} FAIL, {errored} ERROR / {total} total")
    print(f"PASS RATE: {passed/total*100:.1f}%")
    print(f"AVG TIME: {sum(r['time'] for r in results)/total:.2f}s")

    # List failures
    failures = [r for r in results if r["status"] in ("FAIL", "ERROR")]
    if failures:
        print(f"\nFAILURES ({len(failures)}):")
        for r in failures:
            err = r.get("error", "0 results")
            print(f"  {r['idx']:3d}. {r['label']:40s} → {err}")

    warnings = [r for r in results if r["status"] == "WARN"]
    if warnings:
        print(f"\nWARNINGS ({len(warnings)}):")
        for r in warnings:
            print(f"  {r['idx']:3d}. {r['label']:40s} → formatter issue")

    # Save results
    with open("test_results.json", "w") as f:
        json.dump({"total": total, "passed": passed, "warned": warned, "failed": failed, "errored": errored, "results": results}, f, indent=2)
    print(f"\nResults saved to test_results.json")


if __name__ == "__main__":
    asyncio.run(main())
