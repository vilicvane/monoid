package app.monoid.plugins.qrscanner;

import static org.junit.Assert.*;

import org.junit.Test;

public class QrPreviewBoundsTest {
    @Test
    public void mapsViewportFractionsWithoutAddingInsets() {
        QrPreviewSurface.Bounds bounds = new QrPreviewSurface.Bounds(0.1, 0.2, 0.8, 0.5);
        assertEquals(new QrPreviewSurface.Pixels(108, 480, 864, 1200), bounds.toPixels(1080, 2400));
        assertEquals(new QrPreviewSurface.Pixels(240, 216, 1920, 540), bounds.toPixels(2400, 1080));
        assertEquals(new QrPreviewSurface.Pixels(0, 0, 1080, 2400),
            new QrPreviewSurface.Bounds(0, 0, 1, 1).toPixels(1080, 2400));
    }

    @Test
    public void rejectsEmptyNonfiniteAndOutOfViewportBounds() {
        double[][] invalid = {
            {-0.1, 0, 0.5, 0.5}, {0, -0.1, 0.5, 0.5}, {0, 0, 0, 0.5}, {0, 0, 0.5, 0},
            {0.6, 0, 0.5, 0.5}, {0, 0.6, 0.5, 0.5},
            {Double.NaN, 0, 1, 1}, {0, Double.NaN, 1, 1},
            {0, 0, Double.NaN, 1}, {0, 0, 1, Double.NaN},
            {Double.NEGATIVE_INFINITY, 0, 1, 1}, {0, 0, 1, Double.POSITIVE_INFINITY}
        };
        for (double[] values : invalid) {
            assertThrows(IllegalArgumentException.class,
                () -> new QrPreviewSurface.Bounds(values[0], values[1], values[2], values[3]));
        }
    }

    @Test
    public void preservesPixelEdgesAndExposesSubpixelAreas() {
        assertEquals(new QrPreviewSurface.Pixels(1, 0, 2, 3),
            new QrPreviewSurface.Bounds(0.2, 0, 0.8, 1).toPixels(3, 3));
        assertEquals(0, new QrPreviewSurface.Bounds(0, 0, 0.00001, 1).toPixels(1080, 2400).width());
        assertEquals(new QrPreviewSurface.Pixels(0, 0, 0, 0),
            new QrPreviewSurface.Bounds(0, 0, 1, 1).toPixels(0, 0));
    }
}
