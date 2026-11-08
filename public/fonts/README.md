# Fonts

All fonts here are under the SIL Open Font License 1.1 (see the LICENSE files).

The three Pixelify Sans files have their `liga` feature removed. In these latin subsets the "fi" and "fl"
ligatures render as a glyph that looks like "A" (so "finally" reads "Anally"), in page text and on the canvas.
Removing the feature from the font fixes it in every browser. If you replace these files, strip `liga` again
(fontTools: drop the feature record from GSUB) or check that "fi" and "fl" render correctly.
