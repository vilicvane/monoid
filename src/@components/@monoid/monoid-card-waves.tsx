import type {ReactNode} from 'react';
import {useEffect, useRef} from 'react';
import {styled} from 'styled-components';

const WAVE_WIDTH_RATIO = 0.1;
const WAVE_FADE_IN_SECONDS = 1;
const OUTSIDE_MARGIN = 64;

const Canvas = styled.canvas`
  position: absolute;
  top: -${OUTSIDE_MARGIN}px;
  left: -${OUTSIDE_MARGIN}px;
  width: calc(100% + ${OUTSIDE_MARGIN * 2}px);
  height: calc(100% + ${OUTSIDE_MARGIN * 2}px);
  mask:
    linear-gradient(
      90deg,
      transparent,
      black ${OUTSIDE_MARGIN}px,
      black calc(100% - ${OUTSIDE_MARGIN}px),
      transparent
    ),
    linear-gradient(
      transparent,
      black ${OUTSIDE_MARGIN}px,
      black calc(100% - ${OUTSIDE_MARGIN}px),
      transparent
    );
  mask-composite: intersect;
  pointer-events: none;
`;

type BoundaryPoint = {
  x: number;
  y: number;
  normalX: number;
  normalY: number;
  distance: number;
};

type Wave = {radius: number; age: number};

function createBoundary(width: number, height: number): BoundaryPoint[] {
  const radius = (width * 3.18) / 85.6;
  const points: BoundaryPoint[] = [];
  const corners = [
    [width - radius, radius, -Math.PI / 2],
    [width - radius, height - radius, 0],
    [radius, height - radius, Math.PI / 2],
    [radius, radius, Math.PI],
  ] as const;

  const addPoint = (
    x: number,
    y: number,
    normalX: number,
    normalY: number,
  ): void => {
    points.push({
      x,
      y,
      normalX,
      normalY,
      distance: Math.hypot(x - width / 4, y - height / 2),
    });
  };

  for (const [index, [x, y, angle]] of corners.entries()) {
    for (let step = 0; step <= 8; step++) {
      const normalX = Math.cos(angle + (step / 8) * (Math.PI / 2));
      const normalY = Math.sin(angle + (step / 8) * (Math.PI / 2));

      addPoint(x + radius * normalX, y + radius * normalY, normalX, normalY);
    }

    const [nextX, nextY] = corners[(index + 1) % corners.length]!;
    const normalX = Math.cos(angle + Math.PI / 2);
    const normalY = Math.sin(angle + Math.PI / 2);
    const steps = Math.ceil(Math.hypot(nextX - x, nextY - y) / 4);

    for (let step = 1; step < steps; step++) {
      addPoint(
        x + radius * normalX + ((nextX - x) * step) / steps,
        y + radius * normalY + ((nextY - y) * step) / steps,
        normalX,
        normalY,
      );
    }
  }

  return points;
}

export function MonoidCardWaves({
  scanning,
  active,
}: {
  scanning: boolean;
  active: boolean;
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scanningRef = useRef(scanning);
  const activeRef = useRef(active);
  const drawStaticRef = useRef<() => void>(undefined);

  useEffect(() => {
    scanningRef.current = scanning;
    activeRef.current = active;
    drawStaticRef.current?.();
  }, [scanning, active]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const frame = canvas.parentElement!;
    const context = canvas.getContext('2d')!;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    let width: number;
    let height: number;
    let waveWidth: number;
    let boundary: BoundaryPoint[];
    let cardPath: Path2D;
    let outsidePath: Path2D;
    let maximumRadius: number;
    let nearestEdge: number;
    let animationFrame: number;
    let previousTime: number | undefined;
    let waves: Wave[] = [];

    const draw = (visibleWaves: Wave[]): void => {
      context.clearRect(
        -OUTSIDE_MARGIN,
        -OUTSIDE_MARGIN,
        width + OUTSIDE_MARGIN * 2,
        height + OUTSIDE_MARGIN * 2,
      );

      for (const wave of visibleWaves) {
        context.globalAlpha = Math.max(
          0,
          Math.min(
            wave.age / WAVE_FADE_IN_SECONDS,
            (maximumRadius - wave.radius) / 96,
            1,
          ),
        );
        context.save();
        context.clip(cardPath);
        context.fillStyle = 'rgba(145, 153, 163, 0.09)';
        context.beginPath();
        context.arc(width / 4, height / 2, wave.radius, 0, Math.PI * 2);
        context.arc(
          width / 4,
          height / 2,
          Math.max(0, wave.radius - waveWidth),
          0,
          Math.PI * 2,
        );
        context.fill('evenodd');
        context.restore();

        if (wave.radius <= nearestEdge) {
          continue;
        }

        context.save();
        context.clip(outsidePath, 'evenodd');
        context.fillStyle = 'rgba(225, 232, 240, 0.07)';
        context.beginPath();

        // Each point emits outward only after this wave reaches the card edge.
        for (const offset of [0, waveWidth]) {
          for (const [index, point] of boundary.entries()) {
            const distance = Math.max(0, wave.radius - offset - point.distance);
            const x = point.x + point.normalX * distance;
            const y = point.y + point.normalY * distance;

            if (index === 0) {
              context.moveTo(x, y);
            } else {
              context.lineTo(x, y);
            }
          }

          context.closePath();
        }

        context.fill('evenodd');
        context.restore();
      }
    };

    const drawStatic = (): void => {
      if (reducedMotion.matches) {
        draw(
          (scanningRef.current ? [0.35, 0.6] : [0.45]).map(scale => ({
            radius: width * scale,
            age: 1,
          })),
        );
      }
    };

    const resize = (): void => {
      const style = getComputedStyle(frame);
      const size = {
        width: parseFloat(style.width),
        height: parseFloat(style.height),
      };
      const scale = width === undefined ? 1 : size.width / width;

      ({width, height} = size);
      waveWidth = width * WAVE_WIDTH_RATIO;

      for (const wave of waves) {
        wave.radius *= scale;
      }

      const pixelRatio = window.devicePixelRatio;

      canvas.width = Math.ceil((width + OUTSIDE_MARGIN * 2) * pixelRatio);
      canvas.height = Math.ceil((height + OUTSIDE_MARGIN * 2) * pixelRatio);
      context.setTransform(
        pixelRatio,
        0,
        0,
        pixelRatio,
        OUTSIDE_MARGIN * pixelRatio,
        OUTSIDE_MARGIN * pixelRatio,
      );

      boundary = createBoundary(width, height);
      nearestEdge = Math.min(...boundary.map(point => point.distance));
      maximumRadius =
        Math.max(...boundary.map(point => point.distance)) +
        OUTSIDE_MARGIN +
        waveWidth;
      cardPath = new Path2D();
      cardPath.roundRect(0, 0, width, height, (width * 3.18) / 85.6);
      outsidePath = new Path2D();
      outsidePath.rect(
        -OUTSIDE_MARGIN,
        -OUTSIDE_MARGIN,
        width + OUTSIDE_MARGIN * 2,
        height + OUTSIDE_MARGIN * 2,
      );
      outsidePath.addPath(cardPath);

      draw(waves);
      drawStatic();
    };

    const animate = (time: number): void => {
      const elapsed =
        previousTime === undefined
          ? 0
          : Math.min((time - previousTime) / 1000, 0.05);
      const interval = scanningRef.current ? 0.55 : 1.8;
      const speed = width * (scanningRef.current ? 0.3 : 0.23);
      const spacing = Math.max(waveWidth * 1.5, speed * interval);

      previousTime = time;

      for (const wave of waves) {
        wave.radius += speed * elapsed;
        wave.age += elapsed;
      }

      waves = waves.filter(wave => wave.radius < maximumRadius);

      const lastWave = waves[waves.length - 1];

      if (
        activeRef.current &&
        (lastWave === undefined || lastWave.radius >= spacing)
      ) {
        waves.push({radius: 0, age: 0});
      }

      draw(waves);
      animationFrame = requestAnimationFrame(animate);
    };

    const updateMotion = (): void => {
      cancelAnimationFrame(animationFrame);
      previousTime = undefined;

      if (reducedMotion.matches) {
        drawStatic();
      } else {
        animationFrame = requestAnimationFrame(animate);
      }
    };

    resize();
    updateMotion();
    drawStaticRef.current = drawStatic;

    const resizeObserver = new ResizeObserver(resize);

    resizeObserver.observe(frame);
    reducedMotion.addEventListener('change', updateMotion);

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      reducedMotion.removeEventListener('change', updateMotion);
      drawStaticRef.current = undefined;
    };
  }, []);

  return <Canvas ref={canvasRef} aria-hidden="true" />;
}
