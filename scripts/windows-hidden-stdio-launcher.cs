using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class WindowsHiddenStdioLauncher
{
    private const int HANDLE_FLAG_INHERIT = 0x00000001;
    private const int STARTF_USESHOWWINDOW = 0x00000001;
    private const int STARTF_USESTDHANDLES = 0x00000100;
    private const int SW_HIDE = 0;
    private const int CREATE_NO_WINDOW = 0x08000000;
    private const uint INFINITE = 0xFFFFFFFF;

    private static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("Usage: windows-hidden-stdio-launcher.exe <command> [args...]");
            return 64;
        }

        IntPtr childStdinRead = IntPtr.Zero;
        IntPtr childStdinWrite = IntPtr.Zero;
        IntPtr childStdoutRead = IntPtr.Zero;
        IntPtr childStdoutWrite = IntPtr.Zero;
        IntPtr childStderrRead = IntPtr.Zero;
        IntPtr childStderrWrite = IntPtr.Zero;
        IntPtr processHandle = IntPtr.Zero;
        IntPtr threadHandle = IntPtr.Zero;

        try
        {
            CreateInheritablePipe(out childStdinRead, out childStdinWrite, parentReads: false);
            CreateInheritablePipe(out childStdoutRead, out childStdoutWrite, parentReads: true);
            CreateInheritablePipe(out childStderrRead, out childStderrWrite, parentReads: true);

            var startupInfo = new STARTUPINFO();
            startupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
            startupInfo.wShowWindow = SW_HIDE;
            startupInfo.hStdInput = childStdinRead;
            startupInfo.hStdOutput = childStdoutWrite;
            startupInfo.hStdError = childStderrWrite;

            PROCESS_INFORMATION processInfo;
            var commandLine = new StringBuilder(JoinArguments(args, 0));
            var ok = CreateProcess(
                null,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_NO_WINDOW,
                IntPtr.Zero,
                Environment.CurrentDirectory,
                ref startupInfo,
                out processInfo
            );
            if (!ok)
            {
                Console.Error.WriteLine("CreateProcess failed: " + Marshal.GetLastWin32Error());
                return 1;
            }

            processHandle = processInfo.hProcess;
            threadHandle = processInfo.hThread;

            CloseIfOpen(ref childStdinRead);
            CloseIfOpen(ref childStdoutWrite);
            CloseIfOpen(ref childStderrWrite);
            CloseIfOpen(ref threadHandle);

            var stdinThread = StartRelayThread(
                Console.OpenStandardInput(),
                new FileStream(new SafeFileHandle(childStdinWrite, ownsHandle: true), FileAccess.Write),
                closeOutput: true
            );
            childStdinWrite = IntPtr.Zero;

            var stdoutThread = StartRelayThread(
                new FileStream(new SafeFileHandle(childStdoutRead, ownsHandle: true), FileAccess.Read),
                Console.OpenStandardOutput(),
                closeOutput: false
            );
            childStdoutRead = IntPtr.Zero;

            var stderrThread = StartRelayThread(
                new FileStream(new SafeFileHandle(childStderrRead, ownsHandle: true), FileAccess.Read),
                Console.OpenStandardError(),
                closeOutput: false
            );
            childStderrRead = IntPtr.Zero;

            WaitForSingleObject(processHandle, INFINITE);
            stdoutThread.Join();
            stderrThread.Join();

            int exitCode;
            if (!GetExitCodeProcess(processHandle, out exitCode)) return 1;

            if (stdinThread.IsAlive)
            {
                try { stdinThread.Interrupt(); } catch { }
            }

            return exitCode;
        }
        finally
        {
            CloseIfOpen(ref childStdinRead);
            CloseIfOpen(ref childStdinWrite);
            CloseIfOpen(ref childStdoutRead);
            CloseIfOpen(ref childStdoutWrite);
            CloseIfOpen(ref childStderrRead);
            CloseIfOpen(ref childStderrWrite);
            CloseIfOpen(ref threadHandle);
            CloseIfOpen(ref processHandle);
        }
    }

    private static void CreateInheritablePipe(out IntPtr readHandle, out IntPtr writeHandle, bool parentReads)
    {
        var security = new SECURITY_ATTRIBUTES();
        security.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        security.bInheritHandle = true;

        if (!CreatePipe(out readHandle, out writeHandle, ref security, 0))
        {
            throw new InvalidOperationException("CreatePipe failed: " + Marshal.GetLastWin32Error());
        }

        var parentHandle = parentReads ? readHandle : writeHandle;
        if (!SetHandleInformation(parentHandle, HANDLE_FLAG_INHERIT, 0))
        {
            throw new InvalidOperationException("SetHandleInformation failed: " + Marshal.GetLastWin32Error());
        }
    }

    private static Thread StartRelayThread(Stream input, Stream output, bool closeOutput)
    {
        var thread = new Thread(() =>
        {
            try
            {
                var buffer = new byte[8192];
                int count;
                while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    output.Write(buffer, 0, count);
                    output.Flush();
                }
            }
            catch
            {
                // The other side may close first when the MCP transport shuts down.
            }
            finally
            {
                try { input.Dispose(); } catch { }
                if (closeOutput)
                {
                    try { output.Dispose(); } catch { }
                }
            }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    private static void CloseIfOpen(ref IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return;
        CloseHandle(handle);
        handle = IntPtr.Zero;
    }

    private static string JoinArguments(string[] args, int start)
    {
        var builder = new StringBuilder();
        for (var i = start; i < args.Length; i++)
        {
            if (i > start) builder.Append(' ');
            builder.Append(QuoteArgument(args[i]));
        }
        return builder.ToString();
    }

    private static string QuoteArgument(string arg)
    {
        if (arg.Length == 0) return "\"\"";

        var needsQuotes = false;
        foreach (var c in arg)
        {
            if (char.IsWhiteSpace(c) || c == '"')
            {
                needsQuotes = true;
                break;
            }
        }
        if (!needsQuotes) return arg;

        var builder = new StringBuilder();
        builder.Append('"');
        var backslashes = 0;
        foreach (var c in arg)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            if (c == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }
            builder.Append('\\', backslashes);
            builder.Append(c);
            backslashes = 0;
        }
        builder.Append('\\', backslashes * 2);
        builder.Append('"');
        return builder.ToString();
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(
        out IntPtr hReadPipe,
        out IntPtr hWritePipe,
        ref SECURITY_ATTRIBUTES lpPipeAttributes,
        int nSize
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr hObject, int dwMask, int dwFlags);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        int dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out int lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }
}
