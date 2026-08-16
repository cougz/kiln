# kiln-engine — geometry execution container.
# P1: full stack — cadquery/OCCT (B-rep), trimesh+manifold3d (mesh ops),
# matplotlib (isometric previews). OCP wheels need libGL at import time.
FROM python:3.14.7-slim

# fontconfig + DejaVu: OCCT's font manager needs at least one system font
# or cadquery's .text() dies with an opaque AttributeError (see PLAN.md).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libxrender1 libxext6 \
      fontconfig fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# The OCP wheel vendors its own libfontconfig (cadquery_ocp.libs/) with a
# baked-in config path that doesn't exist in this image — point it at the
# apt-installed config explicitly or it still finds zero fonts.
ENV FONTCONFIG_PATH=/etc/fonts \
    FONTCONFIG_FILE=/etc/fonts/fonts.conf

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py checks.py runner.py render.py .

RUN groupadd --system kiln \
 && useradd --system --gid kiln --create-home --home-dir /home/kiln kiln \
 && mkdir /builds \
 && chown kiln:kiln /builds

EXPOSE 8000
USER kiln
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
