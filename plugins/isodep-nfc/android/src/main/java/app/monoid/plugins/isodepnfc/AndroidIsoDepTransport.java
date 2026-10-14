package app.monoid.plugins.isodepnfc;

import android.nfc.TagLostException;
import android.nfc.tech.IsoDep;
import java.io.IOException;

final class AndroidIsoDepTransport implements SessionController.Transport {
    private final IsoDep isoDep;

    AndroidIsoDepTransport(IsoDep isoDep) {
        this.isoDep = isoDep;
    }

    @Override
    public void connect() throws SessionController.TransportException {
        try {
            isoDep.connect();
        } catch (IOException exception) {
            throw translate(exception);
        }
    }

    @Override
    public SessionController.TagInfo info() {
        return new SessionController.TagInfo(
            isoDep.getTag().getId(), isoDep.getMaxTransceiveLength(), isoDep.isExtendedLengthApduSupported()
        );
    }

    @Override
    public void setTimeout(int timeoutMs) {
        isoDep.setTimeout(timeoutMs);
    }

    @Override
    public byte[] transceive(byte[] data) throws SessionController.TransportException {
        try {
            return isoDep.transceive(data);
        } catch (IOException exception) {
            throw translate(exception);
        }
    }

    @Override
    public void close() throws SessionController.TransportException {
        try {
            isoDep.close();
        } catch (IOException exception) {
            throw translate(exception);
        }
    }

    private static SessionController.TransportException translate(IOException exception) {
        // Android does not reliably distinguish timeout from other IOException causes.
        return new SessionController.TransportException(exception instanceof TagLostException ? "TAG_LOST" : "IO_ERROR");
    }
}
