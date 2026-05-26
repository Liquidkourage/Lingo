Imports System.Linq
Imports System.Text

Public Class BingoCard
    Public Property GameId As String
    Public Property DisplayName As String
    Public Property Grid As Integer(,)
    Public Property Marked As Boolean(,)

    Public Sub New()
        Grid = New Integer(4, 4) {}
        Marked = New Boolean(4, 4) {}
    End Sub

    Public Shared Function Generate(gameId As String, displayName As String, seed As Integer) As BingoCard
        Dim card As New BingoCard With {
            .GameId = gameId,
            .DisplayName = displayName
        }
        Dim rng As New Random(seed)

        For col As Integer = 0 To 4
            Dim minVal As Integer = col * 15 + 1
            Dim columnNumbers = Enumerable.Range(minVal, 15).OrderBy(Function(x) rng.Next()).Take(5).ToArray()
            For row As Integer = 0 To 4
                card.Grid(row, col) = columnNumbers(row)
            Next
        Next

        card.Grid(2, 2) = 0
        card.Marked(2, 2) = True
        Return card
    End Function

    Public Function IsMarked(row As Integer, col As Integer) As Boolean
        If row = 2 AndAlso col = 2 Then Return True
        Return Marked(row, col)
    End Function

    Public Sub ToggleMark(row As Integer, col As Integer)
        If row = 2 AndAlso col = 2 Then Return
        Marked(row, col) = Not Marked(row, col)
    End Sub

    Public Sub ApplyCalledNumber(number As Integer)
        If number < 1 OrElse number > 75 Then Return
        For row As Integer = 0 To 4
            For col As Integer = 0 To 4
                If Grid(row, col) = number Then Marked(row, col) = True
            Next
        Next
    End Sub

    Public Function HasLineWin() As Boolean
        For i As Integer = 0 To 4
            Dim rowIndex = i
            Dim colIndex = i
            If Enumerable.Range(0, 5).All(Function(c) IsMarked(rowIndex, c)) Then Return True
            If Enumerable.Range(0, 5).All(Function(r) IsMarked(r, colIndex)) Then Return True
        Next
        If Enumerable.Range(0, 5).All(Function(idx) IsMarked(idx, idx)) Then Return True
        If Enumerable.Range(0, 5).All(Function(idx) IsMarked(idx, 4 - idx)) Then Return True
        Return False
    End Function

    Public Function CellLabel(row As Integer, col As Integer) As String
        If row = 2 AndAlso col = 2 Then Return "FREE"
        Return Grid(row, col).ToString()
    End Function

    Public Function ToPrintableHtml() As String
        Dim sb As New StringBuilder()
        sb.AppendLine("<div class=""bingo-card"">")
        sb.AppendLine("<h3>" + System.Net.WebUtility.HtmlEncode(DisplayName) + "</h3>")
        sb.AppendLine("<table>")
        sb.AppendLine("<tr><th>B</th><th>I</th><th>N</th><th>G</th><th>O</th></tr>")
        For row As Integer = 0 To 4
            sb.AppendLine("<tr>")
            For col As Integer = 0 To 4
                sb.AppendLine("<td>" + CellLabel(row, col) + "</td>")
            Next
            sb.AppendLine("</tr>")
        Next
        sb.AppendLine("</table></div>")
        Return sb.ToString()
    End Function
End Class
