package app.monoid.plugins.qrscanner;

import android.graphics.Rect;
import android.media.Image;
import androidx.annotation.NonNull;
import androidx.camera.core.ExperimentalGetImage;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.core.util.Consumer;
import com.google.android.gms.tasks.Task;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.Executor;

/** All calls and callbacks use the same serial executor. Create one analyzer per scan. */
final class QrCodeAnalyzer implements ImageAnalysis.Analyzer {
    private final BarcodeScanner scanner;
    private final Executor executor;
    private final Consumer<List<String>> onCodes;
    private final Consumer<Exception> onError;
    private final List<Runnable> onClosed = new ArrayList<>();
    private boolean closing;
    private boolean closed;
    private boolean processing;

    QrCodeAnalyzer(Executor executor, Consumer<List<String>> onCodes, Consumer<Exception> onError) {
        this(BarcodeScanning.getClient(
            new BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        ), executor, onCodes, onError);
    }

    QrCodeAnalyzer(BarcodeScanner scanner, Executor executor, Consumer<List<String>> onCodes, Consumer<Exception> onError) {
        this.scanner = scanner;
        this.executor = executor;
        this.onCodes = onCodes;
        this.onError = onError;
    }

    @Override
    @ExperimentalGetImage
    public void analyze(@NonNull ImageProxy frame) {
        if (closing || processing) {
            frame.close();
            return;
        }

        Image image = frame.getImage();
        if (image == null) {
            frame.close();
            return;
        }

        int rotation = frame.getImageInfo().getRotationDegrees();
        Crop crop = rotatedCrop(frame.getCropRect(), frame.getWidth(), frame.getHeight(), rotation);
        processing = true;

        Task<List<Barcode>> task;
        try {
            task = scanner.process(InputImage.fromMediaImage(image, rotation));
        } catch (RuntimeException exception) {
            releaseFrame(frame);
            onError.accept(exception);
            return;
        }

        task.addOnCompleteListener(executor, result -> {
            try {
                if (closing) {
                    return;
                }
                if (!result.isSuccessful()) {
                    onError.accept(result.isCanceled()
                        ? new CancellationException("QR detection was cancelled.")
                        : result.getException());
                    return;
                }

                List<String> values = new ArrayList<>();
                for (Barcode code : result.getResult()) {
                    Rect bounds = code.getBoundingBox();
                    String value = code.getRawValue();
                    if (bounds != null && value != null && crop.contains(bounds)) {
                        values.add(value);
                    }
                }
                if (!values.isEmpty()) {
                    onCodes.accept(values);
                }
            } finally {
                releaseFrame(frame);
            }
        });
    }

    /** Clear the analyzer first; wait for the callback before unbinding its ImageAnalysis. */
    void close(Runnable callback) {
        if (closed) {
            callback.run();
            return;
        }
        closing = true;
        onClosed.add(callback);
        closeWhenIdle();
    }

    private void releaseFrame(ImageProxy frame) {
        frame.close();
        processing = false;
        closeWhenIdle();
    }

    private void closeWhenIdle() {
        if (closing && !processing && !closed) {
            scanner.close();
            closed = true;
            for (Runnable callback : onClosed) {
                callback.run();
            }
            onClosed.clear();
        }
    }

    /** ML Kit reports bounds in the rotated image; CameraX cropRect uses the original buffer. */
    static Crop rotatedCrop(Rect crop, int width, int height, int rotation) {
        return switch (rotation) {
            case 0 -> new Crop(crop.left, crop.top, crop.right, crop.bottom);
            case 90 -> new Crop(height - crop.bottom, crop.left, height - crop.top, crop.right);
            case 180 -> new Crop(width - crop.right, height - crop.bottom, width - crop.left, height - crop.top);
            case 270 -> new Crop(crop.top, width - crop.right, crop.bottom, width - crop.left);
            default -> throw new IllegalArgumentException("Image rotation must be 0, 90, 180 or 270 degrees.");
        };
    }

    record Crop(int left, int top, int right, int bottom) {
        boolean contains(Rect bounds) {
            return bounds.left < bounds.right && bounds.top < bounds.bottom
                && bounds.left >= left && bounds.top >= top && bounds.right <= right && bounds.bottom <= bottom;
        }
    }
}
