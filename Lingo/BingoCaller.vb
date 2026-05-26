Imports System.Linq

Public Class BingoCall
    Public Property Letter As String
    Public Property Number As Integer

    Public ReadOnly Property Label As String
        Get
            Return Letter + "-" + Number.ToString()
        End Get
    End Property
End Class

Public Class BingoCaller
    Private ReadOnly remaining As New List(Of Integer)
    Private ReadOnly called As New List(Of BingoCall)
    Private ReadOnly rng As New Random()

    Public ReadOnly Property CalledHistory As IList(Of BingoCall)
        Get
            Return called
        End Get
    End Property

    Public ReadOnly Property RemainingCount As Integer
        Get
            Return remaining.Count
        End Get
    End Property

    Public Sub Reset()
        remaining.Clear()
        called.Clear()
        remaining.AddRange(Enumerable.Range(1, 75))
    End Sub

    Public Function CallNext() As BingoCall
        If remaining.Count = 0 Then Return Nothing
        Dim index As Integer = rng.Next(remaining.Count)
        Dim number As Integer = remaining(index)
        remaining.RemoveAt(index)
        Dim letter As String = LetterForNumber(number)
        Dim result As New BingoCall With {.Letter = letter, .Number = number}
        called.Add(result)
        Return result
    End Function

    Public Shared Function LetterForNumber(number As Integer) As String
        If number < 1 OrElse number > 75 Then Return "?"
        Dim letters() As String = {"B", "I", "N", "G", "O"}
        Return letters((number - 1) \ 15)
    End Function
End Class
