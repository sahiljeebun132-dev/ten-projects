# Customer churn prediction - project automation
# Usage: make <target>

PYTHON       ?= python3
PIP          ?= pip
PORT         ?= 8010
HOST         ?= 0.0.0.0
TRAINING_DATE ?= $(shell date -u +%Y-%m-%d)

.DEFAULT_GOAL := help
.PHONY: help install data train evaluate test serve notebook predict all clean clean-artifacts

help:  ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install:  ## Install pinned dependencies
	$(PIP) install --break-system-packages -r requirements.txt

data:  ## Generate data/churn.csv (deterministic, offline)
	$(PYTHON) data/generate_data.py

train:  ## Search, compare and persist the best pipeline
	$(PYTHON) -W ignore -m src.train --training-date $(TRAINING_DATE)

evaluate:  ## Held-out test metrics + all figures
	$(PYTHON) -W ignore -m src.evaluate

test:  ## Run the pytest suite
	$(PYTHON) -m pytest -q

predict:  ## Score the bundled sample record
	$(PYTHON) -W ignore -m src.predict --input data/sample_input.json

serve:  ## Run the FastAPI service (http://localhost:$(PORT)/docs)
	$(PYTHON) -m uvicorn api.main:app --host $(HOST) --port $(PORT)

notebook:  ## Execute notebooks/exploration.ipynb in place
	$(PYTHON) -m nbconvert --to notebook --execute --inplace \
		--ExecutePreprocessor.timeout=1200 notebooks/exploration.ipynb

all: data train evaluate test  ## data -> train -> evaluate -> test

clean:  ## Remove caches
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf .pytest_cache

clean-artifacts: clean  ## Also remove models, reports and generated data
	rm -rf models/*.joblib models/metadata.json reports/*.csv reports/*.json \
		reports/*.txt reports/figures/*.png
