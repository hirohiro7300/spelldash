import functools
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
Handler = functools.partial(SimpleHTTPRequestHandler, directory=ROOT)
ThreadingHTTPServer(("127.0.0.1", 4173), Handler).serve_forever()
