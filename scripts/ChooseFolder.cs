using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using System.Web.Script.Serialization;

internal static class ChooseFolder {
    private delegate bool WindowCallback(IntPtr window, IntPtr value);
    [DllImport("user32.dll")] private static extern bool EnumThreadWindows(uint thread, WindowCallback callback, IntPtr value);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern int GetClassName(IntPtr window, StringBuilder className, int capacity);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);

    [STAThread]
    private static void Main(string[] args) {
        if (args.Length != 1) Environment.Exit(2);
        Application.EnableVisualStyles();
        using (var dialog = new FolderBrowserDialog()) {
            dialog.Description = "Choose a folder to organize";
            dialog.ShowNewFolderButton = false;
            dialog.RootFolder = Environment.SpecialFolder.MyComputer;
            // Show the native picker directly. An invisible owner hid the dialog on this desktop.
            // Once the dialog's window exists, raise that window itself above other applications.
            using (var foreground = new System.Windows.Forms.Timer()) {
                foreground.Interval = 150;
                foreground.Tick += (sender, eventArgs) => {
                    EnumThreadWindows(GetCurrentThreadId(), (window, value) => {
                        var className = new StringBuilder(64);
                        GetClassName(window, className, className.Capacity);
                        if (className.ToString() != "#32770") return true;
                        SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x0043); // TOPMOST, NOMOVE, NOSIZE, SHOWWINDOW
                        SetForegroundWindow(window);
                        foreground.Stop();
                        return false;
                    }, IntPtr.Zero);
                };
                foreground.Start();
                string path = dialog.ShowDialog() == DialogResult.OK ? dialog.SelectedPath : null;
                foreground.Stop();
                File.WriteAllText(args[0], new JavaScriptSerializer().Serialize(new { path = path }), new System.Text.UTF8Encoding(false));
            }
        }
    }
}
