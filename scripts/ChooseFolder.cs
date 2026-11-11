using System;
using System.Windows.Forms;
using System.Web.Script.Serialization;

internal static class ChooseFolder {
    [STAThread]
    private static void Main() {
        Application.EnableVisualStyles();
        using (var dialog = new FolderBrowserDialog()) {
            dialog.Description = "Choose a folder to organize";
            dialog.ShowNewFolderButton = false;
            dialog.RootFolder = Environment.SpecialFolder.MyComputer;
            string path = dialog.ShowDialog() == DialogResult.OK ? dialog.SelectedPath : null;
            Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { path = path }));
        }
    }
}
