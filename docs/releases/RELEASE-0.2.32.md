# Visual Brain 0.2.32

- La mappa collega anche i file Go, Java, Kotlin e C/C++: gli import diventano collegamenti verso i file e le cartelle del progetto. Per Go conta il `go.mod` del modulo; i pacchetti esterni (per esempio `github.com/…`) compaiono fra le tecnologie, la libreria standard no.
- Gli import Python su più righe, come `from . import (a, b)` su righe diverse, ora collegano tutti i moduli citati, e una docstring che contiene la parola «import» non crea collegamenti.
- La lettura usa tree-sitter, con le grammatiche incluse nell'app (circa 2 MB); l'indicizzazione resta veloce quasi quanto prima. Al primo avvio dopo l’aggiornamento i file Python, Go, Java, Kotlin e C/C++ già indicizzati vengono riletti una volta, gli altri no.
