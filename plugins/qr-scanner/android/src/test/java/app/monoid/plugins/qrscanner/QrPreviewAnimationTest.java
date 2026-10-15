package app.monoid.plugins.qrscanner;

import static org.junit.Assert.*;

import org.junit.Test;

public class QrPreviewAnimationTest {
    @Test
    public void acceptsImmediateChangesAndCssBezierOvershoot() {
        QrPreviewSurface.Animation animation = new QrPreviewSurface.Animation(1, 1.5, 0, 1, -0.2, 0, 1.2);
        assertEquals(0, animation.duration(), 0);
        assertEquals(1.5, animation.toScale(), 0);
        assertEquals(-0.2, animation.y1(), 0);
        assertEquals(1.2, animation.y2(), 0);
    }

    @Test
    public void rejectsInvalidScalesDurationsAndBezierControlPoints() {
        double[][] invalid = {
            {0, 1, 320, 0, 0, 1, 1}, {-1, 1, 320, 0, 0, 1, 1},
            {1, 0, 320, 0, 0, 1, 1}, {1, -1, 320, 0, 0, 1, 1},
            {Double.NaN, 1, 320, 0, 0, 1, 1}, {1, Double.POSITIVE_INFINITY, 320, 0, 0, 1, 1},
            {Double.MIN_VALUE, 1, 320, 0, 0, 1, 1}, {1, Double.MAX_VALUE, 320, 0, 0, 1, 1},
            {1, 1, -1, 0, 0, 1, 1}, {1, 1, Double.NaN, 0, 0, 1, 1},
            {1, 1, Double.POSITIVE_INFINITY, 0, 0, 1, 1}, {1, 1, Double.MAX_VALUE, 0, 0, 1, 1},
            {1, 1, 320, -0.1, 0, 1, 1}, {1, 1, 320, 0, 0, 1.1, 1},
            {1, 1, 320, Double.NaN, 0, 1, 1}, {1, 1, 320, 0, Double.NaN, 1, 1},
            {1, 1, 320, 0, 0, Double.NaN, 1}, {1, 1, 320, 0, 0, 1, Double.NaN},
            {1, 1, 320, 0, Double.NEGATIVE_INFINITY, 1, 1}, {1, 1, 320, 0, 0, 1, Double.POSITIVE_INFINITY}
        };
        for (double[] values : invalid) {
            assertThrows(IllegalArgumentException.class,
                () -> new QrPreviewSurface.Animation(values[0], values[1], values[2], values[3], values[4], values[5], values[6]));
        }
    }
}
