import socket

HOST = "127.0.0.1"   # change if the reader is on another machine
SERVER_PORT = 5000
CLIENT_PORT = 5001    # any free port you choose

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("0.0.0.0", CLIENT_PORT))

# This is the subscribe datagram the server expects.
s.sendto(b"subscribe", (HOST, SERVER_PORT))

while True:
    data, addr = s.recvfrom(65535)
    print(data.decode("utf-8", "replace").rstrip())