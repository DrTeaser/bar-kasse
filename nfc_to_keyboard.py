print("" \
"NFC to Keyboard Emulator")

from smartcard.CardMonitoring import CardMonitor, CardObserver
from smartcard.util import toHexString
from pynput.keyboard import Controller, Key
import time

keyboard = Controller()

class PrintObserver(CardObserver):
    def update(self, observable, actions):
        (addedcards, removedcards) = actions
        for card in addedcards:
            try:
                # Verbindung zur Karte herstellen
                card.connection = card.createConnection()
                card.connection.connect()
                
                # Befehl (APDU) senden, um die UID des Chips auszulesen
                response, sw1, sw2 = card.connection.transmit([0xFF, 0xCA, 0x00, 0x00, 0x00])
                
                # Wenn das Auslesen erfolgreich war (Statuscode 90 00)
                if sw1 == 0x90 and sw2 == 0x00:
                    uid = toHexString(response).replace(' ', '')
                    print(f"✅ Chip erkannt: {uid}")
                    
                    # UID wie eine echte Tastatur eintippen + Enter drücken
                    keyboard.type(uid)
                    keyboard.press(Key.enter)
                    keyboard.release(Key.enter)
            except Exception as e:
                print(f"⚠️ Fehler beim Auslesen: {e}")

print("Starte NFC-Scanner (ACR122U)...")
print("Zum Beenden des Skripts CTRL+C drücken.")

monitor = CardMonitor()
observer = PrintObserver()
monitor.addObserver(observer)

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    print("\nScanner beendet.")
    monitor.deleteObserver(observer)
