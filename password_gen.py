import secrets
import string

def generate_password(length=24):
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*()-_=+"
    return ''.join(secrets.choice(alphabet) for _ in range(length))

if __name__ == "__main__":
    print("--- Secure Password Generator ---")
    for i in range(1, 6):
        print(f"{i}: {generate_password()}")
    print("\n[SECURITY NOTE] Run this locally on your machine for maximum privacy.")
