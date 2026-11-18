"""Validates the Python accounting engine against hand-computed DEMO fixtures."""
import json
import unittest
from pathlib import Path

from backend import portfolio

ROOT = Path(__file__).resolve().parents[1]
FEES = json.loads((ROOT / "config" / "fees.json").read_text(encoding="utf-8"))
CASES = json.loads((ROOT / "tests" / "fixtures" / "portfolio_cases.json").read_text(encoding="utf-8"))["cases"]


class PortfolioFixtureTest(unittest.TestCase):
    def test_cases(self):
        for case in CASES:
            with self.subTest(case["name"]):
                res = portfolio.compute(case["transactions"], FEES, case["prices"], case["options"], case["today"])
                exp = case["expected"]
                by_sym = {h["symbol"]: h for h in res["holdings"]}
                for sym, fields in exp.get("holdings", {}).items():
                    for k, v in fields.items():
                        self.assertAlmostEqual(by_sym[sym][k], v, delta=0.011, msg=f"{sym}.{k}")
                for k, v in exp.get("totals", {}).items():
                    self.assertAlmostEqual(res["totals"][k], v, delta=0.011, msg=f"totals.{k}")
                self.assertEqual(len(res["errors"]), exp.get("errorCount", 0))


class FeeTest(unittest.TestCase):
    def test_slabs_and_minimum(self):
        s = portfolio.schedule_for(FEES, "2025-01-01")
        self.assertEqual(portfolio.commission(s, 50000), 180.0)      # 0.36 % slab, inclusive bound
        self.assertEqual(portfolio.commission(s, 50001), 165.0)      # 0.33 % slab
        self.assertEqual(portfolio.commission(s, 1000), 10.0)        # minimum commission
        self.assertEqual(portfolio.commission(s, 3000000), 8100.0)   # 0.27 % slab
        self.assertEqual(portfolio.commission(s, 20000000), 48000.0) # 0.24 % slab

    def test_effective_dates(self):
        self.assertEqual(portfolio.schedule_for(FEES, "2019-05-01")["commissionSlabs"][0]["rate"], 0.004)
        self.assertEqual(portfolio.schedule_for(FEES, "2021-01-01")["cgt"]["shortTermRate"], 0.05)
        self.assertEqual(portfolio.schedule_for(FEES, "2024-01-01")["cgt"]["shortTermRate"], 0.075)

    def test_no_double_counting(self):
        # Net return must equal cash out minus cash in plus current value, independently summed.
        case = CASES[0]
        res = portfolio.compute(case["transactions"], FEES, case["prices"], case["options"], case["today"])
        cash_in = 50212.5 + 28130.0
        cash_out = (36000 - 129.6 - 5.4 - 25 - 339.6) + 427.5
        self.assertAlmostEqual(res["totals"]["netReturn"], cash_out + 54450 - cash_in, delta=0.011)


if __name__ == "__main__":
    unittest.main()
