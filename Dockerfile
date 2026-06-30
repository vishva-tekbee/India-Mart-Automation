# ── Stage 1: Build with Playwright + Chromium ────────────────────────────────
FROM mcr.microsoft.com/playwright/python:v1.48.0-noble

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright browsers (Chromium only for smaller image)
RUN playwright install chromium

# Copy application code
COPY . .

# Expose the API port
EXPOSE 8000

# Run the FastAPI app
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
