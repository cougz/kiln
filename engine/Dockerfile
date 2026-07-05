# kiln-engine — geometry execution container.
# P1: full stack — cadquery/OCCT (B-rep), trimesh+manifold3d (mesh ops),
# matplotlib (isometric previews). OCP wheels need libGL at import time.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libxrender1 libxext6 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py checks.py runner.py render.py .

EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
