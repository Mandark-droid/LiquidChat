package android.print;

import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;

/**
 * Drives a PrintDocumentAdapter straight to a file, bypassing the system print
 * dialog. LayoutResultCallback / WriteResultCallback have package-private
 * constructors, which is why this class lives in the android.print package
 * (the same technique used by react-native-html-to-pdf).
 */
public final class PdfPrintBridge {

    public interface Done {
        void onDone(boolean ok, String error);
    }

    public static void print(
            final PrintDocumentAdapter adapter,
            final PrintAttributes attributes,
            final ParcelFileDescriptor output,
            final Done done) {
        adapter.onStart();
        adapter.onLayout(null, attributes, null, new PrintDocumentAdapter.LayoutResultCallback() {
            @Override
            public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                adapter.onWrite(
                        new PageRange[]{PageRange.ALL_PAGES},
                        output,
                        new CancellationSignal(),
                        new PrintDocumentAdapter.WriteResultCallback() {
                            @Override
                            public void onWriteFinished(PageRange[] pages) {
                                adapter.onFinish();
                                done.onDone(true, null);
                            }

                            @Override
                            public void onWriteFailed(CharSequence error) {
                                adapter.onFinish();
                                done.onDone(false, error == null ? "write failed" : error.toString());
                            }

                            @Override
                            public void onWriteCancelled() {
                                adapter.onFinish();
                                done.onDone(false, "write cancelled");
                            }
                        });
            }

            @Override
            public void onLayoutFailed(CharSequence error) {
                adapter.onFinish();
                done.onDone(false, error == null ? "layout failed" : error.toString());
            }

            @Override
            public void onLayoutCancelled() {
                adapter.onFinish();
                done.onDone(false, "layout cancelled");
            }
        }, null);
    }
}
