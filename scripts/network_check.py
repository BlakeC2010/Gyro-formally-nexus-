import socket
import subprocess
import platform

def run_diagnostic():
    print("--- Nexus Network Diagnostic ---")
    
    # 1. Get Hostname
    hostname = socket.gethostname()
    print(f"[+] Hostname: {hostname}")

    # 2. Get Local IP
    try:
        # This method works even without an internet connection
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        local_ip = "127.0.0.1 (Loopback/Offline)"
    print(f"[+] Local IP: {local_ip}")

    # 3. Connectivity Test (Ping Google DNS)
    print("[...] Testing external connectivity...")
    param = "-n" if platform.system().lower() == "windows" else "-c"
    command = ["ping", param, "1", "8.8.8.8"]
    
    result = subprocess.run(command, capture_output=True, text=True)
    
    if result.returncode == 0:
        print("[SUCCESS] Internet connection active.")
    else:
        print("[ERROR] Could not reach external DNS.")

if __name__ == "__main__":
    run_diagnostic()
