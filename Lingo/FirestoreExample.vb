Imports Google.Cloud.Firestore
Imports System.Threading

Public Class FirestoreExample
    Private ReadOnly firestoreDb As FirestoreDb
    Private userGamePrevious As QuerySnapshot
    Private submissionsPrevious As QuerySnapshot
    Private userGameListener As FirestoreChangeListener
    Private submissionsListener As FirestoreChangeListener
    Private ReadOnly form1instance As Form1

    Public Sub New(form1pass As Form1)
        form1instance = form1pass
        Try
            firestoreDb = FirestoreDb.Create("liquidkourage-16fe5")
            userGameListener = firestoreDb.Collection("userGame").Listen(AddressOf HandleUserGameSnapshot)
            submissionsListener = firestoreDb.Collection("lingoSubmissions").Listen(AddressOf HandleSubmissionsSnapshot)
            form1instance.SetFirestoreStatus("Firestore: listening")
        Catch ex As Exception
            form1instance.SetFirestoreStatus("Firestore error: " + ex.Message)
        End Try
    End Sub

    Private Sub HandleUserGameSnapshot(snapshot As QuerySnapshot)
        If snapshot Is Nothing Then Return
        If userGamePrevious IsNot Nothing Then
            Try
                If form1instance.IsHandleCreated Then
                    form1instance.Invoke(Sub() form1instance.ProcessUserGameChanges(userGamePrevious, snapshot))
                End If
            Catch ex As Exception
                form1instance.SetFirestoreStatus("userGame: " + ex.Message)
            End Try
        End If
        userGamePrevious = snapshot
    End Sub

    Private Sub HandleSubmissionsSnapshot(snapshot As QuerySnapshot)
        If snapshot Is Nothing Then Return
        If submissionsPrevious IsNot Nothing Then
            Try
                If form1instance.IsHandleCreated Then
                    form1instance.Invoke(Sub() form1instance.ProcessSubmissionChanges(submissionsPrevious, snapshot))
                End If
            Catch ex As Exception
                form1instance.SetFirestoreStatus("lingoSubmissions: " + ex.Message)
            End Try
        End If
        submissionsPrevious = snapshot
    End Sub

    Public Sub StopListening()
        If userGameListener IsNot Nothing Then
            userGameListener.StopAsync(CancellationToken.None).Wait()
        End If
        If submissionsListener IsNot Nothing Then
            submissionsListener.StopAsync(CancellationToken.None).Wait()
        End If
    End Sub
End Class
