package app.monoid;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

    private LaunchScreenController launchScreen;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen splashScreen = SplashScreen.installSplashScreen(this);
        launchScreen = new LaunchScreenController(this, splashScreen);
        bridgeBuilder.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageStarted(WebView webView) {
                launchScreen.onPageStarted();
            }

            @Override
            public void onPageLoaded(WebView webView) {
                launchScreen.onPageLoaded(webView);
            }

            @Override
            public void onReceivedError(WebView webView) {
                launchScreen.onPageError();
            }

            @Override
            public void onReceivedHttpError(WebView webView) {
                launchScreen.onPageError();
            }
        });

        super.onCreate(savedInstanceState);
        launchScreen.attach();

        if (getBridge() == null) {
            launchScreen.onPageError();
        }
    }

    @Override
    public void onPause() {
        launchScreen.close("pause");
        super.onPause();
    }

    @Override
    public void onDestroy() {
        launchScreen.close("destroy");
        super.onDestroy();
    }
}
