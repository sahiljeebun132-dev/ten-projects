#!/usr/bin/env python3
"""Project entry point - see src/run_analysis.py for the pipeline itself.

    python data/generate_dataset.py && python run_analysis.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))

from run_analysis import main   # noqa: E402  (src/run_analysis.py)

if __name__ == "__main__":
    main()
