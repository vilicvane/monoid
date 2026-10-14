package app.monoid.plugins.qrscanner;

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import android.graphics.Rect;
import android.media.Image;
import androidx.camera.core.ImageInfo;
import androidx.camera.core.ImageProxy;
import com.google.android.gms.tasks.OnCompleteListener;
import com.google.android.gms.tasks.Task;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.Executor;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.mockito.MockedStatic;

public class QrCodeAnalyzerTest {
    private final BarcodeScanner scanner = mock(BarcodeScanner.class);
    private final InputImage input = mock(InputImage.class);
    @SuppressWarnings("unchecked")
    private final Task<List<Barcode>> task = mock(Task.class);
    private final List<List<String>> results = new ArrayList<>();
    private final List<Exception> errors = new ArrayList<>();
    private final QrCodeAnalyzer analyzer = new QrCodeAnalyzer(scanner, Runnable::run, results::add, errors::add);
    private MockedStatic<InputImage> images;
    private OnCompleteListener<List<Barcode>> completion;

    @Before
    public void setUp() {
        images = mockStatic(InputImage.class);
        images.when(() -> InputImage.fromMediaImage(any(Image.class), anyInt())).thenReturn(input);
        when(scanner.process(input)).thenReturn(task);
        doAnswer(invocation -> {
            completion = invocation.getArgument(1);
            return task;
        }).when(task).addOnCompleteListener(any(Executor.class), any());
    }

    @After
    public void tearDown() {
        images.close();
    }

    @Test
    public void rotatesAsymmetricCropInAllFourOrientations() {
        Rect crop = rect(30, 70, 510, 400);
        int[][] expected = {{30, 70, 510, 400}, {80, 30, 410, 510}, {130, 80, 610, 410}, {70, 130, 400, 610}};
        for (int index = 0; index < expected.length; index++) {
            int[] bounds = expected[index];
            QrCodeAnalyzer.Crop rotated = QrCodeAnalyzer.rotatedCrop(crop, 640, 480, index * 90);
            assertEquals(new QrCodeAnalyzer.Crop(bounds[0], bounds[1], bounds[2], bounds[3]), rotated);
            assertTrue(rotated.contains(rect(bounds[0], bounds[1], bounds[2], bounds[3])));
            assertFalse(rotated.contains(rect(bounds[0] - 1, bounds[1], bounds[2], bounds[3])));
            assertFalse(rotated.contains(rect(bounds[0], bounds[1] - 1, bounds[2], bounds[3])));
            assertFalse(rotated.contains(rect(bounds[0], bounds[1], bounds[2] + 1, bounds[3])));
            assertFalse(rotated.contains(rect(bounds[0], bounds[1], bounds[2], bounds[3] + 1)));
            assertFalse(rotated.contains(rect(bounds[0], bounds[1], bounds[0], bounds[3])));
            assertFalse(rotated.contains(rect(bounds[0], bounds[1], bounds[2], bounds[1])));
        }
    }

    @Test
    public void filtersByRotatedCropAndKeepsRawTextUnchanged() {
        ImageProxy frame = frame(90);
        analyzer.analyze(frame);
        when(task.isSuccessful()).thenReturn(true);
        List<Barcode> codes = List.of(
            code("  wc:example\n", rect(80, 30, 410, 510)),
            code("outside", rect(79, 30, 410, 510)),
            code(null, rect(90, 40, 100, 50)),
            code("missing bounds", null),
            code("empty bounds", rect(90, 40, 90, 50))
        );
        when(task.getResult()).thenReturn(codes);
        verify(frame, never()).close();
        completion.onComplete(task);
        assertEquals(List.of(List.of("  wc:example\n")), results);
        assertTrue(errors.isEmpty());
        verify(frame).close();
        verify(frame.getImage(), never()).close();
    }

    @Test
    public void closeSuppressesDelayedSuccess() { closeDuringDetection(0); }

    @Test
    public void closeSuppressesDelayedFailure() { closeDuringDetection(1); }

    @Test
    public void closeSuppressesDelayedCancellation() { closeDuringDetection(2); }

    private void closeDuringDetection(int outcome) {
        ImageProxy frame = frame(0);
        analyzer.analyze(frame);
        Runnable first = mock(Runnable.class);
        Runnable second = mock(Runnable.class);
        analyzer.close(first);
        analyzer.close(second);
        verify(scanner, never()).close();
        verifyNoInteractions(first, second);
        when(task.isSuccessful()).thenReturn(outcome == 0);
        when(task.isCanceled()).thenReturn(outcome == 2);
        when(task.getException()).thenReturn(new IllegalStateException("late failure"));
        Barcode code = code("late", rect(40, 80, 100, 150));
        when(task.getResult()).thenReturn(List.of(code));
        completion.onComplete(task);
        verify(frame).close();
        verify(scanner).close();
        verify(first).run();
        verify(second).run();
        assertTrue(results.isEmpty());
        assertTrue(errors.isEmpty());
        Runnable third = mock(Runnable.class);
        analyzer.close(third);
        verify(third).run();
        verify(scanner).close();
        ImageProxy laterFrame = frame(0);
        analyzer.analyze(laterFrame);
        verify(laterFrame).close();
        verify(scanner).process(input);
    }

    @Test
    public void failuresAndCancellationsReleaseFrameAndReportErrors() {
        for (boolean cancelled : new boolean[] {false, true}) {
            ImageProxy frame = frame(0);
            analyzer.analyze(frame);
            Exception failure = new IllegalStateException("decode failed");
            when(task.isCanceled()).thenReturn(cancelled);
            when(task.getException()).thenReturn(failure);
            completion.onComplete(task);
            assertTrue(cancelled ? errors.get(1) instanceof CancellationException : errors.get(0) == failure);
            verify(frame).close();
        }
        assertEquals(2, errors.size());
        assertTrue(results.isEmpty());
    }

    @Test
    public void missingImageAndSynchronousFailureReleaseFrames() {
        ImageProxy missing = mock(ImageProxy.class);
        analyzer.analyze(missing);
        verify(missing).close();
        verifyNoInteractions(scanner);
        IllegalStateException failure = new IllegalStateException("scanner unavailable");
        when(scanner.process(input)).thenThrow(failure);
        ImageProxy frame = frame(0);
        analyzer.analyze(frame);
        verify(frame).close();
        assertEquals(List.of(failure), errors);
        Runnable closed = mock(Runnable.class);
        analyzer.close(closed);
        verify(scanner).close();
        verify(closed).run();
    }

    private static ImageProxy frame(int rotation) {
        ImageProxy frame = mock(ImageProxy.class);
        ImageInfo info = mock(ImageInfo.class);
        when(frame.getImage()).thenReturn(mock(Image.class));
        when(frame.getImageInfo()).thenReturn(info);
        when(info.getRotationDegrees()).thenReturn(rotation);
        when(frame.getCropRect()).thenReturn(rect(30, 70, 510, 400));
        when(frame.getWidth()).thenReturn(640);
        when(frame.getHeight()).thenReturn(480);
        return frame;
    }

    private static Barcode code(String value, Rect bounds) {
        Barcode code = mock(Barcode.class);
        when(code.getRawValue()).thenReturn(value);
        when(code.getBoundingBox()).thenReturn(bounds);
        return code;
    }

    private static Rect rect(int left, int top, int right, int bottom) {
        Rect bounds = mock(Rect.class);
        bounds.left = left;
        bounds.top = top;
        bounds.right = right;
        bounds.bottom = bottom;
        return bounds;
    }
}
